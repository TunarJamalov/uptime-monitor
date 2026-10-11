# Uptime Monitor

A small, self-hosted alternative to hosted uptime services such as UptimeRobot. It runs as a single Node.js process with a SQLite database. No Redis, PostgreSQL, Docker, queue, or external account is required.

## Features

- Monitor types: HTTP/HTTPS, SSL certificate, TCP port, UDP request/response, DNS, Ping, WebSocket, Heartbeat/Cron, and Domain registration expiration (WHOIS)
- HTTP checks with custom method, headers, body, expected status, keyword match, JSON path assertion, and slow-response threshold
- DOWN after a configurable number of consecutive failures (default 2), RECOVERED after one successful check
- Incident history with start, recovery time, duration, and error
- 24-hour, 7-day, and 30-day uptime, latency history, and SSL certificate expiry
- Notifications through Discord, Slack, Telegram, a generic JSON webhook, and optional SMTP email
- Per-monitor notification policy: failure threshold, repeat alerts, recovery alerts, mute
- Notification history with provider, event, result, and error
- Maintenance mode and pause/resume per monitor, optional monitor groups
- Admin dashboard protected by a password plus optional TOTP two-factor authentication
- Public, read-only `/status` page and `/api/status` JSON
- JSON and CSV export, daily SQLite backups, 90-day history retention
- systemd unit for production deployment

## Requirements

Node.js 22 or newer and npm. `better-sqlite3` ships prebuilt binaries for common platforms; otherwise it needs C/C++ build tools. Ping monitors use the system `ping` command.

## Quick start

```sh
git clone https://github.com/TunarJamalov/uptime-monitor.git
cd uptime-monitor
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000/dashboard` and add the first monitor. For production use `npm run build` followed by `npm start`, or the systemd unit described below.

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run from TypeScript sources with `tsx` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the test suite |
| `npm run lint` | Type-check and verify formatting |
| `npm run format` | Format sources with Prettier |

## Pages and endpoints

| Path | Access | Description |
| --- | --- | --- |
| `/status` | Public | Read-only status page, refreshes every minute |
| `/api/status` | Public | Public JSON: name, type, group, state, uptime, latency history, incidents. Request headers, bodies, payloads, and tokens are never included |
| `/api/heartbeat/<token>` | Public (secret URL) | `POST` target for heartbeat monitors |
| `/healthz` | Public | Liveness check for the process itself |
| `/login` | Public | Admin sign-in form |
| `/dashboard` | Admin | Monitor management |
| `/dashboard/notifications` | Admin | Webhook settings and notification history |
| `/dashboard/security` | Admin | TOTP enrollment |
| `/api/admin/*` | Admin | JSON API used by the dashboard, plus `/api/admin/export` and `/api/admin/export.csv` |

## Admin authentication

Authentication is enabled by setting `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `AUTH_ENCRYPTION_KEY` together. The key must be at least 32 characters of random data:

```sh
openssl rand -base64 48
```

With these set, `/dashboard` and `/api/admin/*` require a session cookie obtained from `/login`. Sessions last 8 hours, state-changing requests need the CSRF token the dashboard sends automatically, and repeated failed sign-ins are rate limited per IP.

Two-factor authentication is optional. Open `/dashboard/security`, click *Enable authenticator*, scan the QR code, and store the recovery codes offline. Each recovery code works once. The TOTP secret is stored encrypted with `AUTH_ENCRYPTION_KEY`; changing the key makes the stored secret unusable, so keep it backed up. TOTP can also be enrolled before the first sign-in through `GET` and `POST /api/auth/setup` with Basic Auth.

When the three variables are empty the dashboard has no authentication. Only run it that way on a private network or behind a reverse proxy that adds its own protection.

## Creating a monitor

Every monitor has a name, type, optional group, check interval in seconds (minimum 5), and timeout in milliseconds (minimum 100). Type-specific fields:

| Type | URL format | Extra fields |
| --- | --- | --- |
| `http` | `https://example.com/health` | `expectedStatus`, `method`, `headers`, `body`, `keyword`, `jsonPath` + `jsonExpected`, `maxLatency` |
| `ssl` | `https://example.com` | Same as `http`; certificate validity and days remaining are recorded on every HTTPS check |
| `tcp` | `tcp://db.example.com:5432` | `maxLatency` |
| `udp` | `udp://example.com:53` | `udpPayload`, `udpExpectedResponse` |
| `dns` | `dns://example.com` | `maxLatency` |
| `ping` | `ping://example.com` | `maxLatency` |
| `websocket` | `wss://example.com/socket` | `maxLatency` |
| `heartbeat` | generated automatically | `expectedInterval`, `gracePeriod` (seconds) |
| `domain` | `example.com` | `warningThreshold`: 30, 14, or 7 days |

Notification policy fields apply to every type: `failureThreshold` (default 2), `repeatNotificationMinutes` (0 disables repeats), `recoveryNotifications`, and `notificationsEnabled`.

A response above `maxLatency` stays UP but is marked slow and triggers one `SLOW` notification until latency returns to normal. `keyword` is matched case-insensitively against the response body. `jsonPath` is a dot path such as `data.status` compared as a string with `jsonExpected`.

### Heartbeat / Cron monitors

After saving a heartbeat monitor, the dashboard shows a private URL such as `POST /api/heartbeat/<token>`. Call it from the job you want to watch:

```cron
*/5 * * * * curl -fsS -X POST https://monitor.example.com/api/heartbeat/TOKEN >/dev/null
```

If no heartbeat arrives within `expectedInterval + gracePeriod` seconds, the monitor becomes DOWN, opens an incident, and notifies. The next heartbeat recovers it. Tokens are stored in SQLite and never appear on the public page.

### Domain expiration monitors

The service performs a WHOIS lookup, stores the registration expiration date, and shows the days remaining. When the domain enters the warning window a `DOMAIN_EXPIRING` notification is sent once. WHOIS formats vary by TLD; a response without a parseable expiration date is treated as a failed check.

### UDP monitors

The checker sends `udpPayload` (an empty datagram when unset) and waits up to the timeout for a reply. When `udpExpectedResponse` is set the reply must match it exactly. Services that do not answer empty datagrams will time out, which is the expected behavior.

## Notifications

Events: `DOWN`, `STILL_DOWN`, `RECOVERED`, `SLOW`, `SSL_EXPIRING`, `DOMAIN_EXPIRING`, and `TEST`.

Webhook delivery is configured in one of two places:

1. **Environment**: `WEBHOOK_PROVIDER` (`discord`, `slack`, `telegram`, or `generic`) and `WEBHOOK_URL`.
2. **Dashboard**: the generic webhook on `/dashboard/notifications`, stored in SQLite. When it is enabled it replaces the environment webhook and lets you turn `DOWN`, `RECOVERED`, and `STILL_DOWN` on or off individually.

Discord webhook URLs can be used directly. Slack receives a `text` payload. For Telegram, use a `sendMessage` URL that already contains the bot token and `chat_id`. Generic webhooks receive:

```json
{
  "event": "DOWN",
  "monitor": { "id": "…", "name": "API", "type": "http", "url": "https://api.example.com/health" },
  "status": "DOWN",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "message": "Error: Expected HTTP 200, received 503\nOutage started: …"
}
```

Webhook requests always use `POST`, follow no redirects, and must answer with a 2xx status. URLs with credentials, `localhost`, `.local`/`.internal` hosts, or addresses that resolve to private networks are rejected. Every attempt is recorded in the notification history. A failed notification never stops monitoring.

SMTP email is enabled when `SMTP_HOST`, `ALERT_FROM`, and `ALERT_TO` are all set.

## Public status page

`/status` lists active monitors grouped by their group name with state, uptime percentages, latency, recent check history, and open incident start time. Paused monitors are hidden. The JSON at `/api/status` exposes the same data and nothing else.

## `monitors.json`

When the database is empty on startup, monitors are imported from `MONITORS_FILE` (default `monitors.json`). Changes made in the dashboard are stored in SQLite and are not written back to the file. See `monitors.json.example`:

```json
[
  {
    "name": "API",
    "url": "https://api.example.com/health",
    "interval": 60,
    "timeout": 10000,
    "expectedStatus": 200,
    "maxLatency": 1000,
    "keyword": "ok"
  }
]
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `loopback` | Express `trust proxy` setting; set to `true` behind a remote reverse proxy so rate limiting sees the real client IP |
| `DATABASE_PATH` | `./data/uptime.db` | SQLite database file |
| `MONITORS_FILE` | `monitors.json` | Initial import file |
| `BACKUP_DIR` | `./data/backups` | Daily SQLite backups; empty disables them |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | empty | Admin credentials; both required to enable authentication |
| `AUTH_ENCRYPTION_KEY` | empty | Required with admin credentials; encrypts the TOTP secret |
| `WEBHOOK_PROVIDER` | `discord` | `discord`, `slack`, `telegram`, or `generic` |
| `WEBHOOK_URL` | empty | Webhook endpoint; empty disables webhooks |
| `WEBHOOK_HEADERS_JSON` | `{}` | Extra headers for generic webhooks |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Webhook request timeout |
| `SSL_EXPIRY_DAYS` | `30` | Send `SSL_EXPIRING` once when a certificate has this many days left |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | empty / `587` / `false` | SMTP server settings |
| `SMTP_USER` / `SMTP_PASSWORD` | empty | Optional SMTP credentials |
| `ALERT_FROM` / `ALERT_TO` | empty | Email sender and recipient |

Never commit `.env`; it is ignored by git.

## Data retention and backups

Checks and incidents older than 90 days are deleted once a day. When `BACKUP_DIR` is set, a copy of the database is written there daily and on demand from the dashboard. Deleting a monitor removes its checks, incidents, and notification history. Pausing a monitor keeps its history.

## Production deployment

```sh
sudo useradd --system --home /opt/uptime-monitor uptime
sudo git clone https://github.com/TunarJamalov/uptime-monitor.git /opt/uptime-monitor
cd /opt/uptime-monitor
sudo -u uptime npm ci && sudo -u uptime npm run build
sudo cp .env.example .env   # then edit .env
sudo cp systemd/uptime-monitor.service /etc/systemd/system/
sudo systemctl enable --now uptime-monitor
journalctl -u uptime-monitor -f
```

Put a reverse proxy with TLS in front of the service when it is reachable from the internet, set `TRUST_PROXY=true` if that proxy runs on another host, and set `NODE_ENV=production` so session cookies are marked `Secure`.

## Limitations

- Checks run from one location only; there is no multi-region probing.
- WHOIS parsing depends on the registry's response format.
- Ping monitors depend on the operating system's `ping` binary and permissions.
- The dashboard is a plain server-rendered page without a build step; it is intentionally simple.

## License

MIT. See `LICENSE`.
