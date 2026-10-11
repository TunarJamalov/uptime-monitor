import type Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';
import net from 'node:net';
import { getWebhookSettings, type MonitorRow } from './db.js';

export type NotificationEvent =
  'DOWN' | 'STILL_DOWN' | 'RECOVERED' | 'SLOW' | 'SSL_EXPIRING' | 'DOMAIN_EXPIRING' | 'TEST';
export interface DeliveryResult {
  success: boolean;
  error?: string;
}
export interface WebhookChannel {
  /** Where the configuration came from: the dashboard-stored webhook or environment variables. */
  source: 'stored' | 'environment' | 'none';
  provider: string;
  url?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Events that this channel is allowed to send. */
  events: Set<NotificationEvent>;
}
export interface WebhookOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const ALL_EVENTS: NotificationEvent[] = [
  'DOWN',
  'STILL_DOWN',
  'RECOVERED',
  'SLOW',
  'SSL_EXPIRING',
  'DOMAIN_EXPIRING',
  'TEST',
];

function privateAddress(address: string) {
  if (net.isIP(address) === 4) {
    const p = address.split('.').map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:') ||
    lower.startsWith('::ffff:')
  );
}

/** Returns an error message when a webhook URL must not be called, otherwise undefined. */
export async function safeWebhook(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Webhook URL is invalid';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'Webhook URL must use HTTP or HTTPS';
  if (
    parsed.username ||
    parsed.password ||
    parsed.hostname === 'localhost' ||
    parsed.hostname.endsWith('.local') ||
    parsed.hostname.endsWith('.internal')
  )
    return 'Webhook URL targets a blocked host';
  try {
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    if (addresses.some((address) => privateAddress(address.address)))
      return 'Webhook URL resolves to a private network';
  } catch {
    return 'Webhook host could not be resolved';
  }
  return undefined;
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('WEBHOOK_HEADERS_JSON must be a JSON object');
  if (Object.values(parsed).some((v) => typeof v !== 'string'))
    throw new Error('WEBHOOK_HEADERS_JSON values must be strings');
  return parsed as Record<string, string>;
}

/** Picks the webhook configuration to use: the stored dashboard webhook wins when it is enabled. */
export function resolveWebhook(db?: Database.Database): WebhookChannel {
  const stored = db ? getWebhookSettings(db) : undefined;
  if (stored?.enabled) {
    const events = new Set<NotificationEvent>(['SLOW', 'SSL_EXPIRING', 'DOMAIN_EXPIRING', 'TEST']);
    if (stored.eventDown) events.add('DOWN');
    if (stored.eventRecovered) events.add('RECOVERED');
    if (stored.eventStillDown) events.add('STILL_DOWN');
    return {
      source: 'stored',
      provider: 'generic',
      url: stored.url,
      headers: stored.headers,
      timeoutMs: stored.timeoutMs,
      events,
    };
  }
  const url = process.env.WEBHOOK_URL?.trim();
  let headers: Record<string, string> = {};
  try {
    headers = parseHeaders(process.env.WEBHOOK_HEADERS_JSON);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  return {
    source: url ? 'environment' : 'none',
    provider: process.env.WEBHOOK_PROVIDER?.trim() || 'discord',
    url: url || undefined,
    headers,
    timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10000) || 10000,
    events: new Set(ALL_EVENTS),
  };
}

function title(event: NotificationEvent, monitor: { name: string }) {
  const labels: Record<NotificationEvent, string> = {
    DOWN: 'DOWN',
    STILL_DOWN: 'STILL DOWN',
    RECOVERED: 'RECOVERED',
    SLOW: 'SLOW RESPONSE',
    SSL_EXPIRING: 'SSL EXPIRING',
    DOMAIN_EXPIRING: 'DOMAIN EXPIRING',
    TEST: 'TEST NOTIFICATION',
  };
  return `${labels[event]}: ${monitor.name}`;
}

/**
 * Sends one webhook notification. Provider-specific payloads:
 * - discord: `{ content }`
 * - slack / telegram: `{ text }` (Telegram expects a sendMessage URL that already carries chat_id)
 * - generic / webhook: a stable JSON document with event, monitor, status, timestamp and message
 */
export async function notify(
  provider: string | undefined,
  webhook: string | undefined,
  event: NotificationEvent,
  monitor: Pick<MonitorRow, 'id' | 'name' | 'url'> & { type?: string },
  details = '',
  options: WebhookOptions = {}
): Promise<DeliveryResult> {
  if (!webhook) return { success: false, error: 'Webhook is not configured' };
  const heading = title(event, monitor);
  const generic = provider === 'generic' || provider === 'webhook';
  let payload: unknown;
  if (generic)
    payload = {
      event,
      monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
      status: event === 'RECOVERED' ? 'UP' : event === 'DOWN' || event === 'STILL_DOWN' ? 'DOWN' : event,
      timestamp: new Date().toISOString(),
      message: details,
    };
  else if (provider === 'slack' || provider === 'telegram')
    payload = { text: `${heading}\n${monitor.url}\n${details}` };
  else payload = { content: `**${heading}**\n${monitor.url}\n${details}` };

  const validation = await safeWebhook(webhook);
  if (validation) {
    console.error(`Webhook rejected: ${validation}`);
    return { success: false, error: validation };
  }
  let customHeaders: Record<string, string> = {};
  if (generic) {
    try {
      customHeaders = options.headers ?? parseHeaders(process.env.WEBHOOK_HEADERS_JSON);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const timeoutMs = options.timeoutMs ?? Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10000) ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...customHeaders },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = `Webhook returned HTTP ${response.status}`;
      console.error(error);
      return { success: false, error };
    }
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Webhook request timed out'
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Webhook failed: ${message}`);
    return { success: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.ALERT_FROM && process.env.ALERT_TO);
}

export async function emailNotify(
  event: NotificationEvent,
  monitor: Pick<MonitorRow, 'name' | 'url'>,
  details: string
): Promise<DeliveryResult> {
  if (!smtpConfigured()) return { success: false, error: 'SMTP is not configured' };
  const subject = title(event, monitor);
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.ALERT_FROM,
      to: process.env.ALERT_TO,
      subject,
      text: `${subject}\n${monitor.url}\n${details}`,
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Email notification failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Sends an event through every configured channel and reports each channel's outcome.
 * Channels that are not configured are reported with `skipped: true` so callers can avoid
 * logging noise in the notification history.
 */
export async function sendEvent(
  db: Database.Database,
  event: NotificationEvent,
  monitor: MonitorRow,
  details: string
) {
  const channel = resolveWebhook(db);
  const webhookAllowed = channel.events.has(event);
  const [webhook, email] = await Promise.all([
    channel.url && webhookAllowed
      ? notify(channel.provider, channel.url, event, monitor, details, {
          headers: channel.headers,
          timeoutMs: channel.timeoutMs,
        })
      : Promise.resolve<DeliveryResult>({
          success: false,
          error: channel.url ? 'Event disabled for this webhook' : 'Webhook is not configured',
        }),
    emailNotify(event, monitor, details),
  ]);
  return {
    webhook: { ...webhook, provider: channel.provider, skipped: !channel.url },
    email: { ...email, provider: 'smtp', skipped: !smtpConfigured() },
  };
}
