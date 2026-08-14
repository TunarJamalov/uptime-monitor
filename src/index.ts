import 'dotenv/config';
import { loadMonitors, type MonitorConfig } from './config.js';
import { checkMonitor, type CheckResult } from './check.js';
import { backupDatabase, cleanup, evaluateHeartbeats, getMonitor, listMonitors, monitorCount, openDatabase, recordCheck, syncMonitors } from './db.js';
import { emailNotify, notify } from './notify.js';
import { createServer } from './server.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/uptime.db');
try { const imported = loadMonitors(process.env.MONITORS_FILE ?? 'monitors.json'); if (!monitorCount(db)) syncMonitors(db, imported); } catch (error) { if (!monitorCount(db)) { console.error(error instanceof Error ? error.message : error); db.close(); process.exit(1); } console.warn(`Monitor import skipped: ${error instanceof Error ? error.message : error}`); }
const timers = new Map<string, NodeJS.Timeout>();
function formatDuration(ms:number) { const minutes=Math.floor(ms/60000); const hours=Math.floor(minutes/60); return hours ? `${hours}h ${minutes%60}m` : `${minutes}m`; }
async function notifyHeartbeat(event:'DOWN'|'RECOVERED', monitor: any, started: number|null) { const details=event==='DOWN'?`Error: Heartbeat missed\nOutage started: ${new Date(started ?? Date.now()).toISOString()}`:`Outage duration: ${formatDuration(Date.now()-(started ?? Date.now()))}\nRecovered: ${new Date().toISOString()}`; await Promise.all([notify(process.env.WEBHOOK_PROVIDER,process.env.WEBHOOK_URL,event,monitor,details),emailNotify(event,monitor,details)]); }
export async function runMonitor(monitor: MonitorConfig): Promise<CheckResult> {
  const current=getMonitor(db,monitor.id); if (current?.maintenance) return {status:'UP',latency:0};
  const result=await checkMonitor(monitor); const transition=recordCheck(db,monitor,result); const row=getMonitor(db,monitor.id)!;
  if (transition.transitionedDown) { const details=`Error: ${result.error}\nOutage started: ${new Date(row.outageStarted!).toISOString()}`; await Promise.all([notify(process.env.WEBHOOK_PROVIDER,process.env.WEBHOOK_URL,'DOWN',row,details),emailNotify('DOWN',row,details)]); }
  if (transition.recovered) { const details=`Outage duration: ${formatDuration(Date.now()-(transition.outageStarted ?? Date.now()))}\nRecovered: ${new Date().toISOString()}`; await Promise.all([notify(process.env.WEBHOOK_PROVIDER,process.env.WEBHOOK_URL,'RECOVERED',row,details),emailNotify('RECOVERED',row,details)]); }
  if (transition.slowAlert) { const details=`Latency ${result.latency}ms exceeded ${monitor.maxLatency}ms`; await Promise.all([notify(process.env.WEBHOOK_PROVIDER,process.env.WEBHOOK_URL,'SLOW',row,details),emailNotify('SLOW',row,details)]); }
  if (transition.sslAlert) { const details=`Certificate expires in ${result.certificate?.daysRemaining} days`; await Promise.all([notify(process.env.WEBHOOK_PROVIDER,process.env.WEBHOOK_URL,'SSL_EXPIRING',row,details),emailNotify('SSL_EXPIRING',row,details)]); }
  return result;
}
function stopMonitor(id:string) { const timer=timers.get(id); if (timer) clearInterval(timer); timers.delete(id); }
function startMonitor(monitor: MonitorConfig) { stopMonitor(monitor.id); if (!monitor.active || monitor.type==='heartbeat' || getMonitor(db,monitor.id)?.maintenance) return; void runMonitor(monitor); timers.set(monitor.id,setInterval(()=>void runMonitor(monitor),monitor.interval*1000)); }
function refreshSchedules() { const active=listMonitors(db); const ids=new Set(active.map(m=>m.id)); timers.forEach((_timer,id)=>{if(!ids.has(id)) stopMonitor(id);}); active.forEach(startMonitor); }
refreshSchedules(); const heartbeatTimer=setInterval(()=>evaluateHeartbeats(db).forEach(item=>void notifyHeartbeat('DOWN',item.monitor,item.outageStarted)),1000); const cleanupTimer=setInterval(()=>{ cleanup(db); if (process.env.BACKUP_DIR) void backupDatabase(db,process.env.BACKUP_DIR).catch(error=>console.error(`Database backup failed: ${error instanceof Error ? error.message : error}`)); },24*60*60*1000); cleanup(db);
const app=createServer(db,refreshSchedules,runMonitor,async(monitor,transition)=>{if(transition.recovered)await notifyHeartbeat('RECOVERED',getMonitor(db,monitor.id)!,transition.outageStarted);}); const port=Number(process.env.PORT ?? 3000); const server=app.listen(port,()=>console.log(`Uptime monitor listening on port ${port}`));
function shutdown() { timers.forEach(clearInterval); clearInterval(heartbeatTimer); clearInterval(cleanupTimer); server.close(()=>{db.close();process.exit(0);}); }
process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
