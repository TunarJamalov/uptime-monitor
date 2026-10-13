import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });
import fs from 'node:fs';
import { loadMonitors } from './config.js';
import { checkMonitor, type CheckResult } from './check.js';
import { checkDomain } from './domain.js';
import {
  backupDatabase,
  cleanup,
  evaluateHeartbeats,
  getMonitor,
  listMonitors,
  logNotification,
  markIncidentNotified,
  monitorCount,
  openDatabase,
  recordCheck,
  recordDomainResult,
  repeatIncidents,
  syncMonitors,
  type MonitorRow,
} from './db.js';
import { sendEvent, type NotificationEvent } from './notify.js';
import { createServer } from './server.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/uptime.db');

/* ---------- Initial import from monitors.json (only when the database is empty) ---------- */
const monitorsFile = process.env.MONITORS_FILE ?? 'monitors.json';
if (!monitorCount(db)) {
  if (!fs.existsSync(monitorsFile)) {
    console.log(`No ${monitorsFile} found; starting without monitors`);
  } else {
    try {
      syncMonitors(db, loadMonitors(monitorsFile));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      db.close();
      process.exit(1);
    }
  }
}

/* ---------- Notifications ---------- */
function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

async function deliver(monitor: MonitorRow, event: NotificationEvent, details: string, incidentId?: number) {
  if (monitor.notificationsEnabled === false) return;
  if (event === 'RECOVERED' && monitor.recoveryNotifications === false) return;
  const { webhook, email } = await sendEvent(db, event, monitor, details);
  // Channels that are not configured at all are not logged to keep the history meaningful.
  if (!webhook.skipped)
    logNotification(db, monitor.id, incidentId, event, webhook.provider, webhook.success, webhook.error);
  if (!email.skipped)
    logNotification(db, monitor.id, incidentId, event, email.provider, email.success, email.error);
  if (incidentId && (event === 'DOWN' || event === 'STILL_DOWN')) markIncidentNotified(db, incidentId);
}

async function notifyHeartbeat(
  event: 'DOWN' | 'RECOVERED',
  monitor: MonitorRow,
  started: number | null,
  incidentId?: number
) {
  const details =
    event === 'DOWN'
      ? `Error: Heartbeat missed\nOutage started: ${new Date(started ?? Date.now()).toISOString()}`
      : `Outage duration: ${formatDuration(Date.now() - (started ?? Date.now()))}\nRecovered: ${new Date().toISOString()}`;
  await deliver(monitor, event, details, incidentId);
}

async function repeatNotifications() {
  for (const incident of repeatIncidents(db)) {
    const monitor = getMonitor(db, incident.monitorId);
    if (monitor)
      await deliver(
        monitor,
        'STILL_DOWN',
        `Incident has remained DOWN since ${new Date(incident.startedAt).toISOString()}`,
        incident.incidentId
      );
  }
}

/* ---------- Running a single check ---------- */
export async function runMonitor(monitor: MonitorRow): Promise<CheckResult> {
  const current = getMonitor(db, monitor.id);
  if (!current) return { status: 'DOWN', latency: 0, error: 'Monitor no longer exists' };
  if (current.maintenance) return { status: 'UP', latency: 0 };
  if (current.type === 'domain') {
    const domain = await checkDomain(current);
    const transition = recordDomainResult(db, current, domain);
    const row = getMonitor(db, current.id)!;
    if (transition.transitionedDown)
      await deliver(
        row,
        'DOWN',
        `Error: ${domain.error}\nDomain check failed: ${new Date().toISOString()}`,
        transition.incidentId
      );
    if (transition.recovered)
      await deliver(row, 'RECOVERED', `Domain check recovered: ${new Date().toISOString()}`);
    if (transition.warning)
      await deliver(row, 'DOMAIN_EXPIRING', `Domain ${row.url} expires in ${domain.daysRemaining} days`);
    return { status: domain.status, latency: 0, error: domain.error };
  }
  const result = await checkMonitor(current);
  const transition = recordCheck(db, current, result);
  const row = getMonitor(db, current.id)!;
  if (transition.transitionedDown)
    await deliver(
      row,
      'DOWN',
      `Error: ${result.error}\nOutage started: ${new Date(row.outageStarted ?? Date.now()).toISOString()}`,
      transition.incidentId
    );
  if (transition.recovered)
    await deliver(
      row,
      'RECOVERED',
      `Outage duration: ${formatDuration(Date.now() - (transition.outageStarted ?? Date.now()))}\nRecovered: ${new Date().toISOString()}`
    );
  if (transition.slowAlert)
    await deliver(row, 'SLOW', `Latency ${result.latency}ms exceeded ${current.maxLatency}ms`);
  if (transition.sslAlert)
    await deliver(row, 'SSL_EXPIRING', `Certificate expires in ${result.certificate?.daysRemaining} days`);
  return result;
}

/* ---------- Scheduling ---------- */
const timers = new Map<string, { timer: NodeJS.Timeout; signature: string }>();
const running = new Set<string>();

function scheduleKey(monitor: MonitorRow) {
  // Only the fields that influence how a check is executed restart the timer.
  return JSON.stringify([
    monitor.type,
    monitor.url,
    monitor.interval,
    monitor.timeout,
    monitor.expectedStatus,
    monitor.keyword,
    monitor.maxLatency,
    monitor.method,
    monitor.headers,
    monitor.body,
    monitor.jsonPath,
    monitor.jsonExpected,
    monitor.udpPayload,
    monitor.udpExpectedResponse,
    monitor.warningThreshold,
    monitor.active,
    monitor.maintenance,
  ]);
}

function stopMonitor(id: string) {
  const entry = timers.get(id);
  if (entry) clearInterval(entry.timer);
  timers.delete(id);
}

async function tick(id: string) {
  if (running.has(id)) return; // never overlap checks of the same monitor
  running.add(id);
  try {
    const monitor = getMonitor(db, id);
    if (monitor) await runMonitor(monitor);
  } catch (error) {
    console.error(`Check failed for ${id}: ${error instanceof Error ? error.message : error}`);
  } finally {
    running.delete(id);
  }
}

function startMonitor(monitor: MonitorRow) {
  const signature = scheduleKey(monitor);
  if (timers.get(monitor.id)?.signature === signature) return;
  stopMonitor(monitor.id);
  if (!monitor.active || monitor.type === 'heartbeat' || monitor.maintenance) return;
  void tick(monitor.id);
  timers.set(monitor.id, {
    timer: setInterval(() => void tick(monitor.id), monitor.interval * 1000),
    signature,
  });
}

function refreshSchedules() {
  const monitors = listMonitors(db);
  const ids = new Set(monitors.map((m) => m.id));
  for (const id of [...timers.keys()]) if (!ids.has(id)) stopMonitor(id);
  monitors.forEach(startMonitor);
}

refreshSchedules();
const heartbeatTimer = setInterval(() => {
  for (const item of evaluateHeartbeats(db))
    void notifyHeartbeat('DOWN', item.monitor, item.outageStarted, item.incidentId);
}, 1000);
const repeatTimer = setInterval(() => void repeatNotifications(), 60000);
const cleanupTimer = setInterval(
  () => {
    cleanup(db);
    if (process.env.BACKUP_DIR)
      backupDatabase(db, process.env.BACKUP_DIR).catch((error) =>
        console.error(`Database backup failed: ${error instanceof Error ? error.message : error}`)
      );
  },
  24 * 60 * 60 * 1000
);
cleanup(db);

/* ---------- HTTP server ---------- */
const app = createServer(db, refreshSchedules, runMonitor, async (monitor, transition) => {
  if (transition.recovered)
    await notifyHeartbeat('RECOVERED', getMonitor(db, monitor.id)!, transition.outageStarted);
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const server = app.listen(port, host, () =>
  console.log(`Uptime monitor listening on http://${host}:${port}`)
);
server.on('error', (error) => {
  console.error(`Cannot listen on port ${port}: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  for (const id of [...timers.keys()]) stopMonitor(id);
  clearInterval(heartbeatTimer);
  clearInterval(repeatTimer);
  clearInterval(cleanupTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
