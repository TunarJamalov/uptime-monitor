# Uptime Monitor

This project is a self-hosted alternative to a hosted service such as UptimeRobot. It runs as a single Node.js process and requires no Redis, PostgreSQL, Docker, queue, or user account.

## Features

- HTTP/HTTPS monitors with interval, timeout, expected status, and keyword checks
- TCP, DNS, Ping, WebSocket, and SSL monitor types using the same checker interface
- Optional monitor groups for organizing related services
- Add, edit, delete, enable, disable, and manually test monitors from the dashboard
- Maintenance mode for planned outages without creating incidents
- DOWN after two consecutive failures and RECOVERED after a successful check
- Real SQLite history and separate incident history
- 24-hour, 7-day, and 30-day uptime calculations
- Latency sparklines and optional `maxLatency` slow-response warnings
- HTTPS certificate validity, expiration date, and remaining days
- Discord, Slack, and Telegram-compatible webhook notifications
- Optional SMTP email notifications
- Heartbeat/Cron monitoring with generated private URLs
- Shareable, read-only `/status` page
- Automatic 90-day history and incident retention
- systemd and journald support

## Screens

- `/dashboard`: Admin dashboard for monitor management. It contains the monitor form and cards backed by real SQLite data.
- `/status`: A public, read-only status page without authentication. `/api/status` exposes the same public data as JSON.

> `/dashboard` has no account or authentication system. For an internet-facing installation, protect it with a reverse proxy, IP allowlist, Basic Auth, or VPN. The public page is intended for sharing.

## Requirements

Node.js 22 or newer and npm. `better-sqlite3` may require C/C++ build tools on some platforms.

## Installation

```sh
git clone <repository-url> uptime-monitor
cd uptime-monitor
npm install
cp .env.example .env
npm run build
npm start
```

The production `monitors.json` starts empty; no demo monitor is seeded. See `monitors.json.example` for an example configuration. Add the first monitor at `http://localhost:3000/dashboard`. Use `npm run dev` for development and `npm test` for tests.

## Creating A Monitor

The dashboard form supports these fields:

- `name`: Display name
- `url`: Must use `http://` or `https://`
- `interval`: Seconds, minimum 5
- `timeout`: Milliseconds, minimum 100
- `expectedStatus`: HTTP status from 100 to 599
- `keyword`: Optional, matched case-insensitively in the response body
- `maxLatency`: Optional millisecond threshold. A response above this value remains UP but is marked `slow`.
- `type`: `http`, `ssl`, `tcp`, `dns`, `ping`, or `websocket`. HTTP remains the default for existing configurations.
- `group`: Optional group label for organizing monitors.
- `method`, `headers`, `body`: Optional HTTP request customization.
- `jsonPath`, `jsonExpected`: Optional dot-path response JSON assertion.

Non-HTTP examples use URL schemes such as `tcp://db.example.com:5432`, `dns://example.com`, `ping://example.com`, and `wss://example.com/socket`.

## Heartbeat / Cron Monitoring

Create a monitor with type `heartbeat` in the dashboard. Set the expected interval and grace period in seconds. The dashboard generates a private URL such as:

```text
POST /api/heartbeat/<TOKEN>
```

Do not publish this URL. Add it to a cron job, deployment hook, or scheduled task:

```cron
*/5 * * * * curl -fsS -X POST https://monitor.example.com/api/heartbeat/TOKEN >/dev/null
```

The monitor is considered healthy when a heartbeat arrives. If no heartbeat arrives within `expected interval + grace period`, it becomes DOWN and uses the existing incident and notification system. The next heartbeat changes it to RECOVERED and closes the incident. Tokens are stored in SQLite, are not logged, and are excluded from the public status page.

Disabling a monitor preserves its history but stops new checks. Deleting a monitor also deletes its check and incident history.

Use the `Maintenance` button before planned work. Maintenance pauses checks and shows a MAINTENANCE state publicly without opening an incident. Use `Resume` to start checks again.

## `monitors.json`

The file is used as the initial/import configuration:

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

When the application starts with an empty database, it imports this file into SQLite. Dashboard changes are preserved on later starts. To import again, back up the SQLite file and start with a clean database.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/uptime.db` | SQLite database file |
| `MONITORS_FILE` | `monitors.json` | Initial import file |
| `WEBHOOK_PROVIDER` | `discord` | `discord`, `slack`, or `telegram` |
| `WEBHOOK_URL` | empty | Notification endpoint; empty disables notifications |
| `ADMIN_USERNAME` | empty | Optional Basic Auth username for the dashboard and admin API |
| `ADMIN_PASSWORD` | empty | Optional Basic Auth password for the dashboard and admin API |
| `SSL_EXPIRY_DAYS` | `30` | Notify once when an HTTPS certificate enters this expiry window |
| `BACKUP_DIR` | `./data/backups` | Directory for daily SQLite backups; empty disables automatic backups |
| `SMTP_HOST` | empty | SMTP server for email alerts |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use TLS for SMTP |
| `SMTP_USER` / `SMTP_PASSWORD` | empty | Optional SMTP credentials |
| `ALERT_FROM` / `ALERT_TO` | empty | Email sender and recipient; both enable email alerts |

Use `.env.example` as a starting point. Never log or commit the secret webhook URL.

When both `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set, `/dashboard` and `/api/admin/*` require HTTP Basic Authentication. `/status` and `/api/status` remain public. Set both values in production; leaving them empty is intended only for a trusted local installation.

## Notifications

DOWN notifications include the monitor name, URL, error, and outage start. RECOVERED notifications include the monitor name, URL, outage duration, and recovery time. One failure does not create a DOWN state. The monitoring process continues if a webhook request fails.

Discord webhook URLs can be used directly. Slack receives a `text` payload. For Telegram, use a `sendMessage` endpoint with the bot token and `chat_id` in the URL. SSL certificate data is persisted and displayed in the dashboard; a separate SSL expiry webhook alert is on the roadmap.

## Uptime And Incident History

Uptime is the UP ratio of real check results recorded in the selected time window. Time before a monitor was created is not counted as downtime. The current API returns 100 when no check exists yet.

After two consecutive failures, a row is created in the SQLite `incidents` table. When recovery occurs, `recovered_at` and `duration` are stored. An open incident does not send repeated notifications.

## SSL Monitoring

HTTPS monitors inspect peer certificate information during every HTTP check. The dashboard shows valid/invalid, expiration date, and remaining days. HTTP monitors do not show an SSL section. The checker is isolated so TCP, Ping, and DNS types can be added later; this release implements HTTP/HTTPS only.

## Data And Retention

The default SQLite file is `data/uptime.db`. Check records contain timestamp, monitor, status, latency, slow flag, and error. Checks and incidents older than 90 days are removed by daily cleanup. Stop the application before copying the SQLite file, or use SQLite backup:

```sh
sqlite3 data/uptime.db ".backup 'backup/uptime-$(date +%F).db'"
```

When `BACKUP_DIR` is configured, the process creates a timestamped SQLite backup during the daily cleanup. The authenticated admin API also provides `/api/admin/export` for monitor/status JSON export and `POST /api/admin/backup` for an immediate backup.

CSV export is available at `/api/admin/export.csv`. Both export endpoints require the same admin authentication as the dashboard. Email alerts use SMTP only when all required SMTP and address variables are configured.

## Production systemd Setup

```sh
npm ci
npm run build
sudo useradd --system --home /opt/uptime-monitor --shell /usr/sbin/nologin uptime
sudo install -d -o uptime -g uptime /opt/uptime-monitor
```

Place the built project, `monitors.json`, and `.env` under `/opt/uptime-monitor`. The paths in `systemd/uptime-monitor.service` assume this directory:

```sh
sudo cp systemd/uptime-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uptime-monitor
journalctl -u uptime-monitor -f
```

The service runs as the non-root `uptime` user, restarts after crashes, and logs to journald. The `uptime` user must own the `data` directory. If you use a reverse proxy, expose only `/status` and `/api/status` publicly.

## Troubleshooting

- `Cannot read monitors.json`: Ensure the file is in the working directory or provide the correct path with `MONITORS_FILE`.
- If a monitor does not start, check JSON syntax, URL scheme, interval, and timeout validation.
- The first failure does not create a DOWN incident because two failures are required.
- DNS, TLS, and timeout details appear in the latest check error and journald.
- If native SQLite installation fails, check the Node.js version and platform build tools.

## Security And Limitations

The application does not serve `.env`, SQLite, `monitors.json`, or arbitrary filesystem files. Monitor fields are validated and HTML-escaped. When `ADMIN_USERNAME` and `ADMIN_PASSWORD` are configured, the admin dashboard uses Basic Authentication. Keep the dashboard behind a trusted network or reverse proxy to reduce SSRF risk.

This project does not provide distributed monitoring, multi-user permissions, SMS escalation, or hosted global probes. Checks run from one server; if that server is unreachable, checks stop. Basic Authentication is available for the single admin dashboard.

## Roadmap

- Role-based access and stronger admin session security
- Richer incident timelines and response-body diagnostics
- Additional notification providers and multi-region probes

## License

MIT. Add the standard MIT copyright notice before publishing the project.
