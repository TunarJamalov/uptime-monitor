import { afterEach, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import { checkMonitor } from '../src/check.js';
import { checkDomain } from '../src/domain.js';
import { validateMonitor } from '../src/config.js';
import { cleanup, evaluateHeartbeats, getMonitor, incidents, logNotification, notificationHistory, openDatabase, receiveHeartbeat, recordCheck, recordDomainResult, saveMonitor, setMaintenance, syncMonitors, uptime } from '../src/db.js';
import { createServer } from '../src/server.js';
import { notify } from '../src/notify.js';
import type Database from 'better-sqlite3';

const monitor = { id:'monitor-1', name:'Test', url:'https://example.com', interval:60, timeout:1000, expectedStatus:200 };
let db: Database.Database;
afterEach(() => db?.close());

describe('checks', () => {
  it('accepts status and keyword case-insensitively', async () => { const result=await checkMonitor(monitor, async () => new Response('Welcome home',{status:200})); expect(result.status).toBe('UP'); });
  it('rejects unexpected status and keyword mismatch', async () => { expect((await checkMonitor(monitor,async()=>new Response('',{status:503}))).error).toContain('Expected HTTP 200'); expect((await checkMonitor({...monitor,keyword:'needle'},async()=>new Response('nope',{status:200}))).error).toContain('Keyword'); });
  it('marks a successful response as slow without making it DOWN', async () => { const result=await checkMonitor({...monitor,maxLatency:1},async()=>{await new Promise(r=>setTimeout(r,5));return new Response('',{status:200});}); expect(result.status).toBe('UP'); expect(result.slow).toBe(true); });
  it('handles timeout and network errors', async () => { const timeout=checkMonitor(monitor,()=>new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),5)) as Promise<Response>); expect((await timeout).error).toContain('timed out'); expect((await checkMonitor(monitor,async()=>{throw new Error('DNS failure')})).error).toBe('DNS failure'); });
  it('performs a real UDP request and validates the response', async () => { const socket=dgram.createSocket('udp4'); socket.on('message',(message,remote)=>socket.send('pong',remote.port,remote.address)); await new Promise<void>(resolve=>socket.bind(0,'127.0.0.1',()=>resolve())); const port=(socket.address() as any).port; const result=await checkMonitor({id:'udp',name:'UDP',url:`udp://127.0.0.1:${port}`,type:'udp',interval:60,timeout:1000,expectedStatus:200,udpPayload:'ping',udpExpectedResponse:'pong'},fetch); expect(result.status).toBe('UP'); socket.close(); });
});

describe('state and history', () => {
  it('transitions down after two failures, does not repeat, and recovers with outage start', () => { db=openDatabase(':memory:'); syncMonitors(db,[monitor]); const down={status:'DOWN' as const,latency:4,error:'offline'}; expect(recordCheck(db,monitor,down,100).transitionedDown).toBe(false); const second=recordCheck(db,monitor,down,200); expect(second.transitionedDown).toBe(true); expect(recordCheck(db,monitor,down,300).transitionedDown).toBe(false); expect(incidents(db,monitor.id)[0]).toMatchObject({startedAt:200,recoveredAt:null,error:'offline'}); expect(getMonitor(db,monitor.id)?.state).toBe('DOWN'); const recovery=recordCheck(db,monitor,{status:'UP',latency:3},500); expect(recovery.recovered).toBe(true); expect(recovery.outageStarted).toBe(200); expect(incidents(db,monitor.id)[0]).toMatchObject({recoveredAt:500,duration:300}); expect(getMonitor(db,monitor.id)?.state).toBe('UP'); });
  it('calculates uptime and removes records older than 90 days', () => { db=openDatabase(':memory:'); syncMonitors(db,[monitor]); recordCheck(db,monitor,{status:'UP',latency:1},1000); recordCheck(db,monitor,{status:'DOWN',latency:1,error:'x'},2000); expect(uptime(db,monitor.id,0,3000)).toBe(50); recordCheck(db,monitor,{status:'UP',latency:1},0); expect(cleanup(db,Date.now())).toBe(3); });
  it('persists maintenance mode without changing monitor history', () => { db=openDatabase(':memory:'); syncMonitors(db,[monitor]); expect(setMaintenance(db,monitor.id,true)?.maintenance).toBe(true); expect(getMonitor(db,monitor.id)?.maintenance).toBe(true); expect(setMaintenance(db,monitor.id,false)?.maintenance).toBe(false); });
});

describe('admin to public persistence flow', () => {
  it('persists a created monitor and serves it from the public database query', async () => {
    db=openDatabase(':memory:');
    let refreshed=false;
    const app=createServer(db,()=>{refreshed=true;},async monitor=>{recordCheck(db,monitor,{status:'UP',latency:42});return {status:'UP',latency:42};});
    const server=app.listen(0); await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
    const port=(server.address() as any).port;
    const created=await fetch(`http://127.0.0.1:${port}/api/admin/monitors`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Bordaz',url:'https://bordaz.app/',interval:60,timeout:10000,expectedStatus:200,maxLatency:2000})});
    expect(created.status).toBe(201); expect(refreshed).toBe(true);
    const saved=await created.json(); expect(getMonitor(db,saved.id)?.name).toBe('Bordaz');
    recordCheck(db,saved,{status:'UP',latency:42});
    const publicResponse=await fetch(`http://127.0.0.1:${port}/api/status`); const publicData=await publicResponse.json();
    expect(publicData).toHaveLength(1); expect(publicData[0]).toMatchObject({name:'Bordaz',url:'https://bordaz.app/',latestLatency:42});
    const dashboardHtml=await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text();
    const dashboardScript=dashboardHtml.match(/<script>([\s\S]*)<\/script>/)?.[1]; expect(dashboardScript).toBeTruthy(); expect(() => new Function(dashboardScript!)).not.toThrow();
    server.close();
  });
});

describe('heartbeat monitors', () => {
  it('defaults heartbeat timing when an existing monitor is changed to heartbeat', () => { const monitor=validateMonitor({name:'Existing',url:'heartbeat://pending',type:'heartbeat',interval:5,timeout:1000,expectedStatus:200,expectedInterval:0},'heartbeat-edit'); expect(monitor.expectedInterval).toBe(60); expect(monitor.gracePeriod).toBe(0); });
  it('also treats empty or null form values as empty heartbeat timing', () => { expect(validateMonitor({name:'Empty',url:'heartbeat://pending',type:'heartbeat',interval:5,timeout:1000,expectedInterval:'',gracePeriod:0},'heartbeat-empty').expectedInterval).toBe(60); expect(validateMonitor({name:'Null',url:'heartbeat://pending',type:'heartbeat',interval:5,timeout:1000,expectedInterval:null},'heartbeat-null').expectedInterval).toBe(60); });
  it('generates a private token, detects a missed heartbeat, and recovers', () => {
    db=openDatabase(':memory:');
    const heartbeat={id:'heartbeat-1',name:'Cron',url:'heartbeat://pending',type:'heartbeat' as const,group:'Jobs',interval:5,timeout:1000,expectedStatus:200,expectedInterval:60,gracePeriod:10,active:true};
    const saved=saveMonitor(db,heartbeat); expect(saved.heartbeatToken).toBeTruthy();
    const missedAt=saved.createdAt+(saved.expectedInterval!+saved.gracePeriod!)*1000+1;
    expect(evaluateHeartbeats(db,missedAt)).toHaveLength(1); expect(getMonitor(db,saved.id)?.state).toBe('DOWN'); expect(incidents(db,saved.id)[0].error).toContain('Heartbeat');
    const received=receiveHeartbeat(db,saved.heartbeatToken!,missedAt+1000); expect(received?.recovered).toBe(true); expect(getMonitor(db,saved.id)?.state).toBe('UP'); expect(getMonitor(db,saved.id)?.lastHeartbeatAt).toBe(missedAt+1000); expect(incidents(db,saved.id)[0].recoveredAt).toBe(missedAt+1000);
  });
  it('accepts POST heartbeat requests without exposing the token publicly', async () => {
    db=openDatabase(':memory:'); const heartbeat={id:'heartbeat-2',name:'Deploy job',url:'heartbeat://pending',type:'heartbeat' as const,interval:5,timeout:1000,expectedStatus:200,expectedInterval:60,gracePeriod:10,active:true}; const saved=saveMonitor(db,heartbeat); const app=createServer(db,()=>{},async()=>({status:'UP',latency:1})); const server=app.listen(0); await new Promise<void>(resolve=>server.once('listening',()=>resolve())); const port=(server.address() as any).port; const response=await fetch(`http://127.0.0.1:${port}/api/heartbeat/${saved.heartbeatToken}`,{method:'POST'}); expect(response.status).toBe(200); const publicJson=await (await fetch(`http://127.0.0.1:${port}/api/status`)).text(); expect(publicJson).not.toContain(saved.heartbeatToken!); server.close();
  });
});

describe('domain monitors', () => {
  it('parses a real WHOIS-shaped expiration response and records warning state', async () => { const monitor={id:'domain-1',name:'Example',url:'example.com',type:'domain' as const,interval:60,timeout:1000,expectedStatus:200,warningThreshold:30,active:true}; const expiration=Date.now()+14*86400000; const result=await checkDomain(monitor,async()=>({registryExpiryDate:new Date(expiration).toISOString()})); expect(result.status).toBe('UP'); expect(result.warning).toBe(true); db=openDatabase(':memory:'); saveMonitor(db,monitor); const transition=recordDomainResult(db,monitor,result,100); expect(transition.warning).toBe(true); expect(getMonitor(db,monitor.id)?.domainDaysRemaining).toBeGreaterThan(13); });
});

describe('notification policy', () => {
  it('persists per-monitor policy and notification history', () => { db=openDatabase(':memory:'); const saved=saveMonitor(db,{...monitor,failureThreshold:3,recoveryNotifications:false,repeatNotificationMinutes:30,notificationsEnabled:true}); expect(getMonitor(db,saved.id)).toMatchObject({failureThreshold:3,recoveryNotifications:false,repeatNotificationMinutes:30}); logNotification(db,saved.id,7,'DOWN','discord',false,'webhook failed',123); expect(notificationHistory(db,saved.id)[0]).toMatchObject({eventType:'DOWN',provider:'discord',success:0,error:'webhook failed'}); });
  it('rejects private generic webhook targets without throwing', async () => { const result=await notify('generic','http://127.0.0.1:9999/hook','DOWN',{...monitor,type:'http',state:'UP',outageStarted:null,consecutiveFailures:0,createdAt:0,sslValid:null,sslExpiresAt:null,sslDaysRemaining:null,domainExpirationDate:null,domainDaysRemaining:null,warningAlerted:false,maintenance:false,slowAlerted:false,sslAlerted:false,heartbeatToken:undefined,lastHeartbeatAt:null,failureThreshold:2,recoveryNotifications:true,repeatNotificationMinutes:0,notificationsEnabled:true} as any,'test'); expect(result.success).toBe(false); expect(result.error).toContain('private'); });
});
