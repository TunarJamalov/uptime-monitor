import tls from 'node:tls';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MonitorConfig } from './config.js';

export interface CertificateInfo { valid: boolean; expiresAt: number | null; daysRemaining: number | null; error?: string }
export interface CheckResult { status: 'UP' | 'DOWN'; latency: number; error?: string; slow?: boolean; certificate?: CertificateInfo }
const execFileAsync = promisify(execFile);
function simpleResult(started:number, error?:string): CheckResult { return {status:error ? 'DOWN' : 'UP',latency:Date.now()-started,error}; }
async function tcpCheck(url:URL, timeout:number) { const started=Date.now(); return new Promise<CheckResult>(resolve=>{const socket=net.createConnection({host:url.hostname,port:Number(url.port)},()=>{socket.destroy();resolve(simpleResult(started));});const timer=setTimeout(()=>{socket.destroy();resolve(simpleResult(started,'TCP connection timed out'));},timeout);socket.once('error',error=>{clearTimeout(timer);resolve(simpleResult(started,error.message));});socket.once('connect',()=>clearTimeout(timer));}); }
async function udpCheck(url:URL, monitor:MonitorConfig) { const started=Date.now(); return new Promise<CheckResult>(resolve=>{const socket=dgram.createSocket(net.isIP(url.hostname)===6?'udp6':'udp4');let settled=false;const finish=(result:CheckResult)=>{if(settled)return;settled=true;clearTimeout(timer);socket.close();resolve(result);};const timer=setTimeout(()=>finish(simpleResult(started,`UDP request timed out after ${monitor.timeout}ms`)),monitor.timeout);socket.on('error',error=>finish(simpleResult(started,error.message)));socket.on('message',message=>{const response=message.toString();if(monitor.udpExpectedResponse!==undefined&&response!==monitor.udpExpectedResponse)finish(simpleResult(started,`Unexpected UDP response: ${response}`));else finish(simpleResult(started));});socket.send(Buffer.from(monitor.udpPayload ?? ''),Number(url.port),url.hostname,error=>{if(error)finish(simpleResult(started,error.message));});}); }

async function certificate(url: URL, timeout: number): Promise<CertificateInfo | undefined> {
  if (url.protocol !== 'https:') return undefined;
  return new Promise(resolve => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false });
    const timer = setTimeout(() => { socket.destroy(); resolve({ valid: false, expiresAt: null, daysRemaining: null, error: 'Certificate check timed out' }); }, timeout);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const peer = socket.getPeerCertificate();
      const expiresAt = peer.valid_to ? Date.parse(peer.valid_to) : NaN;
      const valid = socket.authorized && Number.isFinite(expiresAt) && expiresAt > Date.now();
      resolve({ valid, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, daysRemaining: Number.isFinite(expiresAt) ? Math.ceil((expiresAt - Date.now()) / 86400000) : null, error: valid ? undefined : socket.authorizationError?.message ?? 'Invalid certificate' });
      socket.destroy();
    });
    socket.once('error', error => { clearTimeout(timer); resolve({ valid: false, expiresAt: null, daysRemaining: null, error: error.message }); });
  });
}

export async function checkMonitor(monitor: MonitorConfig, request: typeof fetch = fetch): Promise<CheckResult> {
  const started = Date.now(); const url = new URL(monitor.url);
  if (monitor.type === 'tcp') return tcpCheck(url,monitor.timeout);
  if (monitor.type === 'udp') return udpCheck(url,monitor);
  if (monitor.type === 'dns') { try { await Promise.race([dns.lookup(url.hostname),new Promise((_,reject)=>setTimeout(()=>reject(new Error('DNS lookup timed out')),monitor.timeout))]); return simpleResult(started); } catch(error) { return simpleResult(started,error instanceof Error?error.message:String(error)); } }
  if (monitor.type === 'ping') { try { await execFileAsync('ping',['-c','1','-W',String(Math.max(1,Math.ceil(monitor.timeout/1000))),url.hostname],{timeout:monitor.timeout}); return simpleResult(started); } catch(error) { return simpleResult(started,error instanceof Error?error.message:'Ping failed'); } }
  if (monitor.type === 'websocket') { return new Promise(resolve=>{const socket=new WebSocket(monitor.url);const timer=setTimeout(()=>{socket.close();resolve(simpleResult(started,'WebSocket connection timed out'));},monitor.timeout);socket.onopen=()=>{clearTimeout(timer);socket.close();resolve(simpleResult(started));};socket.onerror=()=>{clearTimeout(timer);resolve(simpleResult(started,'WebSocket connection failed'));};}); }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), monitor.timeout);
  try {
    const response = await request(monitor.url, { method: monitor.method ?? 'GET', headers: monitor.headers, body: monitor.body, signal: controller.signal, redirect: 'follow' });
    const body = monitor.keyword || monitor.jsonPath ? await response.text() : '';
    const latency = Date.now() - started; const cert = request === fetch && (monitor.type === 'ssl' || url.protocol === 'https:') ? await certificate(url, monitor.timeout) : undefined;
    if (response.status !== monitor.expectedStatus) return { status: 'DOWN', latency, certificate: cert, error: `Expected HTTP ${monitor.expectedStatus}, received ${response.status}` };
    if (monitor.keyword && !body.toLocaleLowerCase().includes(monitor.keyword.toLocaleLowerCase())) return { status: 'DOWN', latency, certificate: cert, error: `Keyword "${monitor.keyword}" was not found` };
    if (monitor.jsonPath) { try { let value: any = JSON.parse(body); for (const part of monitor.jsonPath.split('.')) value=value?.[part]; if (String(value) !== String(monitor.jsonExpected)) return { status: 'DOWN', latency, certificate: cert, error: `JSON value at ${monitor.jsonPath} did not match` }; } catch { return { status: 'DOWN', latency, certificate: cert, error: 'Response was not valid JSON' }; }
    }
    return { status: 'UP', latency, slow: monitor.maxLatency !== undefined && latency > monitor.maxLatency, certificate: cert };
  } catch (error) {
    return { status: 'DOWN', latency: Date.now() - started, error: error instanceof Error && error.name === 'AbortError' ? `Request timed out after ${monitor.timeout}ms` : error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}
