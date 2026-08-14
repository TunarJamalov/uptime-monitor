import { afterEach, describe, expect, it } from 'vitest';
import { checkMonitor } from '../src/check.js';
import { cleanup, getMonitor, incidents, openDatabase, recordCheck, setMaintenance, syncMonitors, uptime } from '../src/db.js';
import { createServer } from '../src/server.js';
import type Database from 'better-sqlite3';

const monitor = { id:'monitor-1', name:'Test', url:'https://example.com', interval:60, timeout:1000, expectedStatus:200 };
let db: Database.Database;
afterEach(() => db?.close());

describe('checks', () => {
  it('accepts status and keyword case-insensitively', async () => { const result=await checkMonitor(monitor, async () => new Response('Welcome home',{status:200})); expect(result.status).toBe('UP'); });
  it('rejects unexpected status and keyword mismatch', async () => { expect((await checkMonitor(monitor,async()=>new Response('',{status:503}))).error).toContain('Expected HTTP 200'); expect((await checkMonitor({...monitor,keyword:'needle'},async()=>new Response('nope',{status:200}))).error).toContain('Keyword'); });
  it('marks a successful response as slow without making it DOWN', async () => { const result=await checkMonitor({...monitor,maxLatency:1},async()=>{await new Promise(r=>setTimeout(r,5));return new Response('',{status:200});}); expect(result.status).toBe('UP'); expect(result.slow).toBe(true); });
  it('handles timeout and network errors', async () => { const timeout=checkMonitor(monitor,()=>new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),5)) as Promise<Response>); expect((await timeout).error).toContain('timed out'); expect((await checkMonitor(monitor,async()=>{throw new Error('DNS failure')})).error).toBe('DNS failure'); });
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
