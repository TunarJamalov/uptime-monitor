import type { MonitorRow } from './db.js';
import nodemailer from 'nodemailer';
export async function notify(provider: string | undefined, webhook: string | undefined, event: 'DOWN' | 'RECOVERED' | 'SLOW' | 'SSL_EXPIRING' | 'DOMAIN_EXPIRING', monitor: MonitorRow, details: string) {
  if (!webhook) return;
  let payload: unknown;
  const title = event === 'DOWN' ? `DOWN: ${monitor.name}` : event === 'RECOVERED' ? `RECOVERED: ${monitor.name}` : event === 'SLOW' ? `SLOW RESPONSE: ${monitor.name}` : event === 'SSL_EXPIRING' ? `SSL EXPIRING: ${monitor.name}` : `DOMAIN EXPIRING: ${monitor.name}`;
  if (provider === 'slack') payload = { text: `${title}\n${monitor.url}\n${details}` };
  else if (provider === 'telegram') payload = { text: `${title}\n${monitor.url}\n${details}` };
  else payload = { content: `**${title}**\n${monitor.url}\n${details}` };
  try { const response = await fetch(webhook, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) }); if (!response.ok) console.error(`Webhook returned HTTP ${response.status}`); } catch (error) { console.error(`Webhook failed: ${error instanceof Error ? error.message : error}`); }
}
export async function emailNotify(event: 'DOWN' | 'RECOVERED' | 'SLOW' | 'SSL_EXPIRING' | 'DOMAIN_EXPIRING', monitor: MonitorRow, details: string) {
  if (!process.env.SMTP_HOST || !process.env.ALERT_FROM || !process.env.ALERT_TO) return;
  const subject = `${event}: ${monitor.name}`;
  try { const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT ?? 587),secure:process.env.SMTP_SECURE === 'true',auth:process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD} : undefined}); await transport.sendMail({from:process.env.ALERT_FROM,to:process.env.ALERT_TO,subject,text:`${subject}\n${monitor.url}\n${details}`}); } catch (error) { console.error(`Email notification failed: ${error instanceof Error ? error.message : error}`); }
}
