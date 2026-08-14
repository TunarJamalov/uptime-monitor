import 'dotenv/config';
import { loadMonitors, type MonitorConfig } from './config.js';
import { checkMonitor, type CheckResult } from './check.js';
import { checkDomain } from './domain.js';
import { backupDatabase, cleanup, evaluateHeartbeats, getMonitor, getWebhookSettings, listMonitors, logNotification, markIncidentNotified, monitorCount, openDatabase, recordCheck, recordDomainResult, repeatIncidents, syncMonitors } from './db.js';
import { emailNotify, notify } from './notify.js';
import { createServer } from './server.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/uptime.db');
const storedWebhook=getWebhookSettings(db); if(storedWebhook?.enabled){process.env.WEBHOOK_PROVIDER='generic';process.env.WEBHOOK_URL=storedWebhook.url;process.env.WEBHOOK_HEADERS_JSON=JSON.stringify(storedWebhook.headers);process.env.WEBHOOK_TIMEOUT_MS=String(storedWebhook.timeoutMs);}
try { const imported = loadMonitors(process.env.MONITORS_FILE ?? 'monitors.json'); if (!monitorCount(db)) syncMonitors(db, imported); } catch (error) { if (!monitorCount(db)) { console.error(error instanceof Error ? error.message : error); db.close(); process.exit(1); } console.warn(`Monitor import skipped: ${error instanceof Error ? error.message : error}`); }
const timers = new Map<string, NodeJS.Timeout>();
function formatDuration(ms:number) { const minutes=Math.floor(ms/60000); const hours=Math.floor(minutes/60); return hours ? `${hours}h ${minutes%60}m` : `${minutes}m`; }
async function notifyHeartbeat(event:'DOWN'|'RECOVERED', monitor: any, started: number|null, incidentId?:number) { const details=event==='DOWN'?`Error: Heartbeat missed\nOutage started: ${new Date(started ?? Date.now()).toISOString()}`:`Outage duration: ${formatDuration(Date.now()-(started ?? Date.now()))}\nRecovered: ${new Date().toISOString()}`; await deliver(monitor,event,details,incidentId); }
async function deliver(monitor:any,event:'DOWN'|'STILL_DOWN'|'RECOVERED'|'SLOW'|'SSL_EXPIRING'|'DOMAIN_EXPIRING',details:string,incidentId?:number) { if(monitor.notificationsEnabled===false || (event==='RECOVERED'&&monitor.recoveryNotifications===false)) return; const settings=getWebhookSettings(db); const genericAllowed=!settings ? true : settings.enabled && ((event==='DOWN'&&settings.eventDown)||(event==='RECOVERED'&&settings.eventRecovered)||(event==='STILL_DOWN'&&settings.eventStillDown)||!['DOWN','RECOVERED','STILL_DOWN'].includes(event)); const [webhook,email]=await Promise.all([genericAllowed?notify(process.env.WEBHOOK_PROVIDER,process.env.WEBHOOK_URL,event,monitor,details):Promise.resolve({success:false,error:'Webhook event disabled'}),emailNotify(event,monitor,details)]); logNotification(db,monitor.id,incidentId,event,process.env.WEBHOOK_PROVIDER??'webhook',webhook.success,webhook.error); logNotification(db,monitor.id,incidentId,event,'smtp',email.success,email.error); if(incidentId&&(event==='DOWN'||event==='STILL_DOWN'))markIncidentNotified(db,incidentId); }
async function repeatNotifications() { for(const incident of repeatIncidents(db)) { const monitor=getMonitor(db,incident.monitorId); if(monitor) await deliver(monitor,'STILL_DOWN',`Incident has remained DOWN since ${new Date(incident.startedAt).toISOString()}`,incident.incidentId); } }
export async function runMonitor(monitor: MonitorConfig): Promise<CheckResult> {
  const current=getMonitor(db,monitor.id); if (current?.maintenance) return {status:'UP',latency:0};
  if (monitor.type==='domain') { const domain=await checkDomain(monitor); const transition=recordDomainResult(db,monitor,domain); const row=getMonitor(db,monitor.id)!; if(transition.transitionedDown)await deliver(row,'DOWN',`Error: ${domain.error}\nDomain check failed: ${new Date().toISOString()}`,transition.incidentId); if(transition.recovered)await deliver(row,'RECOVERED',`Domain check recovered: ${new Date().toISOString()}`); if(transition.warning)await deliver(row,'DOMAIN_EXPIRING',`Domain ${row.url} expires in ${domain.daysRemaining} days`); return {status:domain.status,latency:0,error:domain.error}; }
  const result=await checkMonitor(monitor); const transition=recordCheck(db,monitor,result); const row=getMonitor(db,monitor.id)!;
  if (transition.transitionedDown) await deliver(row,'DOWN',`Error: ${result.error}\nOutage started: ${new Date(row.outageStarted!).toISOString()}`,transition.incidentId);
  if (transition.recovered) await deliver(row,'RECOVERED',`Outage duration: ${formatDuration(Date.now()-(transition.outageStarted ?? Date.now()))}\nRecovered: ${new Date().toISOString()}`);
  if (transition.slowAlert) await deliver(row,'SLOW',`Latency ${result.latency}ms exceeded ${monitor.maxLatency}ms`);
  if (transition.sslAlert) await deliver(row,'SSL_EXPIRING',`Certificate expires in ${result.certificate?.daysRemaining} days`);
  return result;
}
function stopMonitor(id:string) { const timer=timers.get(id); if (timer) clearInterval(timer); timers.delete(id); }
function startMonitor(monitor: MonitorConfig) { stopMonitor(monitor.id); if (!monitor.active || monitor.type==='heartbeat' || getMonitor(db,monitor.id)?.maintenance) return; void runMonitor(monitor); timers.set(monitor.id,setInterval(()=>void runMonitor(monitor),monitor.interval*1000)); }
function refreshSchedules() { const active=listMonitors(db); const ids=new Set(active.map(m=>m.id)); timers.forEach((_timer,id)=>{if(!ids.has(id)) stopMonitor(id);}); active.forEach(startMonitor); }
refreshSchedules(); const heartbeatTimer=setInterval(()=>evaluateHeartbeats(db).forEach(item=>void notifyHeartbeat('DOWN',item.monitor,item.outageStarted,item.incidentId)),1000); const repeatTimer=setInterval(()=>void repeatNotifications(),60000); const cleanupTimer=setInterval(()=>{ cleanup(db); if (process.env.BACKUP_DIR) void backupDatabase(db,process.env.BACKUP_DIR).catch(error=>console.error(`Database backup failed: ${error instanceof Error ? error.message : error}`)); },24*60*60*1000); cleanup(db);
const app=createServer(db,refreshSchedules,runMonitor,async(monitor,transition)=>{if(transition.recovered)await notifyHeartbeat('RECOVERED',getMonitor(db,monitor.id)!,transition.outageStarted);}); const port=Number(process.env.PORT ?? 3000); const server=app.listen(port,()=>console.log(`Uptime monitor listening on port ${port}`));
function shutdown() { timers.forEach(clearInterval); clearInterval(heartbeatTimer); clearInterval(repeatTimer); clearInterval(cleanupTimer); server.close(()=>{db.close();process.exit(0);}); }
process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
