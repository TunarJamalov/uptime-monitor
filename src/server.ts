import express from 'express';
import type Database from 'better-sqlite3';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { validateMonitor, type MonitorConfig } from './config.js';
import {
  backupDatabase,
  dashboardData,
  deleteWebhookSettings,
  exportRows,
  getMonitor,
  getWebhookSettings,
  heartbeatUrl,
  notificationHistory,
  receiveHeartbeat,
  removeMonitor,
  saveMonitor,
  saveWebhookSettings,
  setMaintenance,
  setMonitorActive,
  type MonitorRow,
} from './db.js';
import {
  basicCredentials,
  createSession,
  deleteTotp,
  destroySession,
  hasTotp,
  initAuth,
  randomTotpSetup,
  saveTotp,
  session,
  validateAuthEncryptionKey,
  validCsrf,
  verifyTotp,
} from './auth.js';
import type { CheckResult } from './check.js';
import { notify, resolveWebhook, smtpConfigured } from './notify.js';
import { dashboardPage, loginPage, notificationsPage, publicPage, securityPage } from './ui.js';

const SESSION_HOURS = 8;
const LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createServer(
  db: Database.Database,
  onChanged: () => void,
  runMonitor: (m: MonitorRow) => Promise<CheckResult>,
  onHeartbeat?: (
    monitor: MonitorConfig,
    transition: { recovered: boolean; outageStarted: number | null }
  ) => Promise<void>
) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const configured = Boolean(username || password);
  if (configured && (!username || !password))
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured together');
  if (configured) validateAuthEncryptionKey();
  initAuth(db);

  const app = express();
  app.disable('x-powered-by');
  // Only trust proxy headers from the local reverse proxy unless configured otherwise.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use(express.json({ limit: '50kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const cookie = (req: express.Request, name: string) =>
    req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const basicOk = (req: express.Request) => {
    const c = basicCredentials(req);
    return Boolean(
      c && username && password && sameString(c.username, username) && sameString(c.password, password)
    );
  };
  const setAuthCookies = (
    req: express.Request,
    res: express.Response,
    s: { token: string; csrf: string }
  ) => {
    const secure = process.env.NODE_ENV === 'production' || req.secure;
    const attrs = `Path=/; Max-Age=${SESSION_HOURS * 60 * 60}; SameSite=Strict${secure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', [`session=${s.token}; HttpOnly; ${attrs}`, `csrf=${s.csrf}; ${attrs}`]);
  };
  const clearAuthCookies = (res: express.Response) =>
    res.setHeader('Set-Cookie', [
      'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict',
      'csrf=; Path=/; Max-Age=0; SameSite=Strict',
    ]);

  const failures = new Map<string, { count: number; until: number }>();
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!configured) return next();
    const row = session(db, cookie(req, 'session'));
    if (!row)
      return req.originalUrl.startsWith('/api/')
        ? res.status(401).json({ error: 'Authentication required' })
        : res.redirect('/login');
    if (req.method !== 'GET' && !validCsrf(row, req.headers['x-csrf-token'] as string))
      return res.status(403).json({ error: 'CSRF validation failed' });
    next();
  };

  const setup = () => {
    const s = randomTotpSetup();
    return { ...s, otpauth: `otpauth://totp/Uptime%20Monitor?secret=${s.secret}&issuer=Uptime%20Monitor` };
  };
  const setupResponse = async (
    res: express.Response,
    s: { secret: string; codes: string[]; otpauth: string }
  ) =>
    res.json({
      secret: s.secret,
      recoveryCodes: s.codes,
      otpauth: s.otpauth,
      qrDataUrl: await QRCode.toDataURL(s.otpauth),
    });
  const baseUrl = (req: express.Request) => `${req.protocol}://${req.get('host')}`;
  const monitorError = (res: express.Response, e: unknown) =>
    res.status(400).send(e instanceof Error ? e.message : 'Invalid monitor');

  /* ---------- Public routes ---------- */
  app.get('/', (_q, r) => r.redirect('/status'));
  app.get('/api/status', (_q, r) => r.json(dashboardData(db, true)));
  app.get('/status', (_q, r) => r.type('html').send(publicPage(dashboardData(db, true))));
  app.get('/healthz', (_q, r) => r.json({ ok: true }));
  app.post('/api/heartbeat/:token', async (q, r) => {
    const t = receiveHeartbeat(db, q.params.token);
    if (!t) return r.sendStatus(404);
    if (onHeartbeat) await onHeartbeat(t.monitor, { recovered: t.recovered, outageStarted: t.outageStarted });
    return r.json({ ok: true, receivedAt: Date.now() });
  });

  /* ---------- Authentication ---------- */
  app.get('/login', (_q, r) => (configured ? r.type('html').send(loginPage()) : r.redirect('/dashboard')));
  app.post('/api/auth/login', (req, res) => {
    if (!configured) return res.status(401).json({ error: 'Authentication is not configured' });
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const old = failures.get(ip);
    if (old && old.until > now && old.count >= LOGIN_ATTEMPTS)
      return res.status(429).json({ error: 'Too many attempts, try again later' });
    const passwordOk = basicOk(req);
    const totpOk = !hasTotp(db) || (passwordOk && verifyTotp(db, String(req.body?.code ?? '').trim()));
    if (!passwordOk || !totpOk) {
      const count = (old?.count ?? 0) + 1;
      failures.set(ip, { count, until: now + (count >= LOGIN_ATTEMPTS ? LOCKOUT_MS : 60 * 1000) });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    failures.delete(ip);
    const s = createSession(db);
    setAuthCookies(req, res, s);
    return res.json({ ok: true });
  });
  app.post('/api/auth/logout', auth, (req, res) => {
    destroySession(db, cookie(req, 'session'));
    clearAuthCookies(res);
    res.json({ ok: true });
  });
  // First-time TOTP enrollment with Basic Auth only (before any session exists).
  app.get('/api/auth/setup', async (req, res) => {
    if (!configured || !basicOk(req) || hasTotp(db)) return res.sendStatus(403);
    return setupResponse(res, setup());
  });
  app.post('/api/auth/setup', (req, res) => {
    if (
      !configured ||
      !basicOk(req) ||
      hasTotp(db) ||
      typeof req.body?.secret !== 'string' ||
      !Array.isArray(req.body?.recoveryCodes)
    )
      return res.sendStatus(403);
    saveTotp(db, req.body.secret, req.body.recoveryCodes);
    if (!verifyTotp(db, String(req.body?.code ?? ''))) {
      deleteTotp(db);
      return res.status(400).json({ error: 'Authenticator code is invalid' });
    }
    res.json({ ok: true });
  });

  /* ---------- Admin pages and API ---------- */
  app.use(['/dashboard', '/api/admin'], auth);
  app.get('/dashboard', (_q, r) => r.type('html').send(dashboardPage()));
  app.get('/dashboard/notifications', (_q, r) => r.type('html').send(notificationsPage()));
  app.get('/dashboard/webhooks', (_q, r) => r.redirect('/dashboard/notifications'));
  app.get('/dashboard/security', (_q, r) => r.type('html').send(securityPage()));

  app.get('/api/admin/security', (_q, r) =>
    r.json({ authConfigured: configured, totpConfigured: hasTotp(db) })
  );
  const enableTotp = async (_q: express.Request, r: express.Response) => {
    if (!configured)
      return r.status(400).json({ error: 'Set ADMIN_USERNAME and ADMIN_PASSWORD before enabling TOTP' });
    const s = setup();
    saveTotp(db, s.secret, s.codes);
    return setupResponse(r, s);
  };
  app.post('/api/admin/security/regenerate', enableTotp);
  app.post('/api/admin/security/enable', enableTotp);
  app.post('/api/admin/security/disable', (_q, r) => {
    deleteTotp(db);
    r.json({ ok: true });
  });

  const adminMonitors = (req: express.Request) =>
    dashboardData(db, false).map((m: any) =>
      m.type === 'heartbeat' ? { ...m, heartbeatUrl: heartbeatUrl(db, m.id, baseUrl(req)) } : m
    );
  app.get('/api/admin/monitors', (q, r) => r.json(adminMonitors(q)));
  app.post('/api/admin/monitors', (q, r) => {
    try {
      const { heartbeatToken: _token, ...m } = saveMonitor(db, validateMonitor(q.body, randomUUID()));
      onChanged(); // the scheduler runs the first check immediately
      r.status(201).json(
        m.type === 'heartbeat' ? { ...m, heartbeatUrl: heartbeatUrl(db, m.id, baseUrl(q)) } : m
      );
    } catch (e) {
      monitorError(r, e);
    }
  });
  app.put('/api/admin/monitors/:id', (q, r) => {
    if (!getMonitor(db, q.params.id)) return r.sendStatus(404);
    try {
      const { heartbeatToken: _token, ...m } = saveMonitor(db, validateMonitor(q.body, q.params.id));
      onChanged();
      r.json(m.type === 'heartbeat' ? { ...m, heartbeatUrl: heartbeatUrl(db, m.id, baseUrl(q)) } : m);
    } catch (e) {
      monitorError(r, e);
    }
  });
  app.delete('/api/admin/monitors/:id', (q, r) => {
    if (!getMonitor(db, q.params.id)) return r.sendStatus(404);
    removeMonitor(db, q.params.id);
    onChanged();
    r.sendStatus(204);
  });
  app.post('/api/admin/monitors/:id/test', async (q, r) => {
    const m = getMonitor(db, q.params.id);
    if (!m) return r.sendStatus(404);
    if (m.type === 'heartbeat')
      return r.json({
        status: m.state,
        latency: 0,
        error: 'Heartbeat monitors are tested by sending a heartbeat',
      });
    try {
      r.json(await runMonitor(m));
    } catch (e) {
      r.status(500).json({
        status: 'DOWN',
        latency: 0,
        error: e instanceof Error ? e.message : 'Check failed',
      });
    }
  });
  app.post('/api/admin/monitors/:id/maintenance', (q, r) => {
    const m = setMaintenance(db, q.params.id, Boolean(q.body?.maintenance));
    if (!m) return r.sendStatus(404);
    onChanged();
    r.json(m);
  });
  app.post('/api/admin/monitors/:id/active', (q, r) => {
    const m = setMonitorActive(db, q.params.id, Boolean(q.body?.active));
    if (!m) return r.sendStatus(404);
    onChanged();
    r.json(m);
  });

  app.get('/api/admin/notifications/settings', (_q, r) => {
    const channel = resolveWebhook(db);
    const envUrl = process.env.WEBHOOK_URL?.trim();
    r.json({
      envProvider: process.env.WEBHOOK_PROVIDER?.trim() || 'discord',
      envWebhookConfigured: Boolean(envUrl),
      smtpConfigured: smtpConfigured(),
      activeSource:
        channel.source === 'stored'
          ? 'stored webhook'
          : channel.source === 'environment'
            ? `environment (${channel.provider})`
            : 'none',
    });
  });
  app.get('/api/admin/webhook', (_q, r) =>
    r.json(
      getWebhookSettings(db) ?? {
        name: '',
        url: '',
        enabled: false,
        headers: {},
        eventDown: true,
        eventRecovered: true,
        eventStillDown: true,
        timeoutMs: 10000,
      }
    )
  );
  app.put('/api/admin/webhook', (q, r) => {
    try {
      r.json(saveWebhookSettings(db, q.body));
    } catch (e) {
      r.status(400).send(e instanceof Error ? e.message : 'Invalid webhook');
    }
  });
  app.delete('/api/admin/webhook', (_q, r) => {
    deleteWebhookSettings(db);
    r.sendStatus(204);
  });
  app.post('/api/admin/webhook/test', async (_q, r) => {
    const channel = resolveWebhook(db);
    if (!channel.url) return r.json({ success: false, error: 'No webhook is configured' });
    const sample = { id: 'test', name: 'Test monitor', url: 'https://example.com', type: 'http' };
    r.json(
      await notify(
        channel.provider,
        channel.url,
        'TEST',
        sample,
        'This is a test notification from the uptime monitor.',
        { headers: channel.headers, timeoutMs: channel.timeoutMs }
      )
    );
  });
  app.get('/api/admin/notifications/history', (_q, r) => r.json(notificationHistory(db)));

  app.get('/api/admin/export', (q, r) => {
    r.setHeader('Content-Disposition', 'attachment; filename="uptime-export.json"');
    r.json({ exportedAt: new Date().toISOString(), monitors: adminMonitors(q) });
  });
  app.get('/api/admin/export.csv', (_q, r) => {
    const { checks, incidents } = exportRows(db);
    const lines = ['record,timestamp,monitorId,monitorName,status,latency,slow,recoveredAt,duration,error'];
    for (const c of checks)
      lines.push(
        [
          'check',
          new Date(c.timestamp).toISOString(),
          c.monitorId,
          c.name,
          c.status,
          c.latency,
          c.slow ? 1 : 0,
          '',
          '',
          c.error,
        ]
          .map(csvCell)
          .join(',')
      );
    for (const i of incidents)
      lines.push(
        [
          'incident',
          new Date(i.startedAt).toISOString(),
          i.monitorId,
          i.name,
          i.recoveredAt ? 'RECOVERED' : 'DOWN',
          '',
          '',
          i.recoveredAt ? new Date(i.recoveredAt).toISOString() : '',
          i.duration,
          i.error,
        ]
          .map(csvCell)
          .join(',')
      );
    r.setHeader('Content-Disposition', 'attachment; filename="uptime-export.csv"');
    r.type('text/csv').send(lines.join('\n') + '\n');
  });
  app.post('/api/admin/backup', async (_q, r) => {
    if (!process.env.BACKUP_DIR) return r.status(400).send('BACKUP_DIR is not configured');
    try {
      r.json({ file: await backupDatabase(db, process.env.BACKUP_DIR) });
    } catch (e) {
      r.status(500).send(e instanceof Error ? e.message : 'Backup failed');
    }
  });

  // Malformed JSON bodies and unexpected errors become clean responses instead of stack traces.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as any)?.type === 'entity.parse.failed' ? 400 : ((error as any)?.status ?? 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 400 ? 'Invalid JSON body' : 'Internal server error' });
  });
  return app;
}
