import type { MonitorRow } from './db.js';
import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';
import net from 'node:net';
function privateAddress(address:string) { if (net.isIP(address)===4) { const p=address.split('.').map(Number); return p[0]===10||p[0]===127||p[0]===0||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168; } return address==='::1'||address.startsWith('fc')||address.startsWith('fd')||address.startsWith('fe80:'); }
async function safeWebhook(url:string) { let parsed:URL; try { parsed=new URL(url); } catch { return 'Webhook URL is invalid'; } if (!['http:','https:'].includes(parsed.protocol)) return 'Webhook URL must use HTTP or HTTPS'; if (parsed.username||parsed.password||parsed.hostname==='localhost'||parsed.hostname.endsWith('.local')||parsed.hostname.endsWith('.internal')) return 'Webhook URL targets a blocked host'; try { const addresses=await dns.lookup(parsed.hostname,{all:true}); if(addresses.some(address=>privateAddress(address.address))) return 'Webhook URL resolves to a private network'; } catch { return 'Webhook host could not be resolved'; } return undefined; }
export async function notify(provider: string | undefined, webhook: string | undefined, event: any, monitor: any, details?: string) {
  if (typeof event !== 'string') { details=monitor as string; monitor=event; event='DOWN'; }
  const message=details ?? '';
  if (!webhook) return {success:false,error:'Webhook is not configured'};
  let payload: unknown;
  const title = event === 'DOWN' ? `DOWN: ${monitor.name}` : event === 'STILL_DOWN' ? `STILL DOWN: ${monitor.name}` : event === 'RECOVERED' ? `RECOVERED: ${monitor.name}` : event === 'SLOW' ? `SLOW RESPONSE: ${monitor.name}` : event === 'SSL_EXPIRING' ? `SSL EXPIRING: ${monitor.name}` : `DOMAIN EXPIRING: ${monitor.name}`;
  if (provider === 'generic' || provider === 'webhook') payload = { event, monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url }, status: event === 'RECOVERED' ? 'UP' : event === 'DOWN' || event === 'STILL_DOWN' ? 'DOWN' : event, timestamp: new Date().toISOString(), message };
  else if (provider === 'slack') payload = { text: `${title}\n${monitor.url}\n${message}` };
  else if (provider === 'telegram') payload = { text: `${title}\n${monitor.url}\n${message}` };
  else payload = { content: `**${title}**\n${monitor.url}\n${message}` };
  const validation=await safeWebhook(webhook); if(validation) { console.error(`Webhook rejected: ${validation}`); return {success:false,error:validation}; }
  let customHeaders:Record<string,string>={}; if(provider==='generic' || provider==='webhook') { try { customHeaders=process.env.WEBHOOK_HEADERS_JSON ? JSON.parse(process.env.WEBHOOK_HEADERS_JSON) : {}; if(Object.values(customHeaders).some(value=>typeof value!=='string')) return {success:false,error:'WEBHOOK_HEADERS_JSON values must be strings'}; } catch { return {success:false,error:'WEBHOOK_HEADERS_JSON is invalid JSON'}; } }
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),Number(process.env.WEBHOOK_TIMEOUT_MS??10000));
  try { const response=await fetch(webhook,{method:'POST',redirect:'manual',signal:controller.signal,headers:{'content-type':'application/json',...customHeaders},body:JSON.stringify(payload)}); if(!response.ok) { const error=`Webhook returned HTTP ${response.status}`; console.error(error); return {success:false,error}; } return {success:true}; } catch (error) { const message=error instanceof Error&&error.name==='AbortError'?'Webhook request timed out':error instanceof Error?error.message:String(error); console.error(`Webhook failed: ${message}`); return {success:false,error:message}; } finally { clearTimeout(timer); }
}
export async function emailNotify(event: 'DOWN' | 'STILL_DOWN' | 'RECOVERED' | 'SLOW' | 'SSL_EXPIRING' | 'DOMAIN_EXPIRING', monitor: MonitorRow, details: string) {
  if (!process.env.SMTP_HOST || !process.env.ALERT_FROM || !process.env.ALERT_TO) return {success:false,error:'SMTP is not configured'};
  const subject = `${event}: ${monitor.name}`;
  try { const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT ?? 587),secure:process.env.SMTP_SECURE === 'true',auth:process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD} : undefined}); await transport.sendMail({from:process.env.ALERT_FROM,to:process.env.ALERT_TO,subject,text:`${subject}\n${monitor.url}\n${details}`}); return {success:true}; } catch (error) { const message=error instanceof Error ? error.message : String(error); console.error(`Email notification failed: ${message}`); return {success:false,error:message}; }
}
