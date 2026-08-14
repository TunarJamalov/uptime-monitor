import fs from 'node:fs';
export type MonitorType = 'http' | 'tcp' | 'dns' | 'ping' | 'websocket' | 'ssl';
export interface MonitorConfig { id: string; name: string; url: string; type?: MonitorType; group?: string; interval: number; timeout: number; expectedStatus: number; keyword?: string; maxLatency?: number; active?: boolean; method?: string; headers?: Record<string,string>; body?: string; jsonPath?: string; jsonExpected?: string }

export function validateMonitor(raw: unknown, id: string, label = 'Monitor'): MonitorConfig {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error(`${label}: name is required`);
  if (typeof m.url !== 'string') throw new Error(`${label}: url is required`);
  let url: URL;
  try { url = new URL(m.url); } catch { throw new Error(`${label}: url is invalid`); }
  const type = (m.type as MonitorType | undefined) ?? ({'tcp:':'tcp','dns:':'dns','ping:':'ping','ws:':'websocket','wss:':'websocket'} as Record<string,MonitorType>)[url.protocol] ?? 'http';
  if (!['http','tcp','dns','ping','websocket','ssl'].includes(type)) throw new Error(`${label}: unsupported monitor type`);
  if (type === 'http' || type === 'ssl') { if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}: HTTP/SSL monitors require HTTP or HTTPS URLs`); }
  else if (type === 'websocket') { if (!['ws:','wss:'].includes(url.protocol)) throw new Error(`${label}: websocket monitors require ws or wss URLs`); }
  else if (!['tcp:','dns:','ping:'].includes(url.protocol)) throw new Error(`${label}: ${type} monitors require a ${type}:// URL`);
  for (const key of ['interval', 'timeout', 'expectedStatus']) if (typeof m[key] !== 'number' || !Number.isFinite(m[key])) throw new Error(`${label}: ${key} must be a number`);
  if ((m.interval as number) < 5 || (m.timeout as number) < 100 || (m.expectedStatus as number) < 100 || (m.expectedStatus as number) > 599) throw new Error(`${label}: interval, timeout or expectedStatus is out of range`);
  if (m.keyword !== undefined && typeof m.keyword !== 'string') throw new Error(`${label}: keyword must be a string`);
  if (m.maxLatency !== undefined && (typeof m.maxLatency !== 'number' || m.maxLatency < 1)) throw new Error(`${label}: maxLatency must be a positive number`);
  if (m.method !== undefined && (typeof m.method !== 'string' || !['GET','POST','PUT','PATCH','HEAD'].includes(m.method.toUpperCase()))) throw new Error(`${label}: method must be GET, POST, PUT, PATCH, or HEAD`);
  if (m.headers !== undefined && (!m.headers || typeof m.headers !== 'object' || Object.entries(m.headers as object).some(([key,value]) => !key || typeof value !== 'string'))) throw new Error(`${label}: headers must be a string map`);
  if (m.body !== undefined && typeof m.body !== 'string') throw new Error(`${label}: body must be a string`);
  if (m.jsonPath !== undefined && typeof m.jsonPath !== 'string') throw new Error(`${label}: jsonPath must be a string`);
  if (m.jsonExpected !== undefined && typeof m.jsonExpected !== 'string') throw new Error(`${label}: jsonExpected must be a string`);
  return { id, name: m.name.trim(), url: url.toString(), type, group: typeof m.group === 'string' ? m.group.trim() : undefined, interval: m.interval as number, timeout: m.timeout as number, expectedStatus: m.expectedStatus as number, keyword: m.keyword as string | undefined, maxLatency: m.maxLatency as number | undefined, active: m.active !== false, method: (m.method as string | undefined)?.toUpperCase() ?? 'GET', headers: m.headers as Record<string,string> | undefined, body: m.body as string | undefined, jsonPath: m.jsonPath as string | undefined, jsonExpected: m.jsonExpected as string | undefined };
}

export function loadMonitors(file = 'monitors.json'): MonitorConfig[] {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : error}`); }
  if (!Array.isArray(value)) throw new Error(`${file} must contain a JSON array`);
  return value.map((raw, i) => {
    return validateMonitor(raw, `monitor-${i + 1}`, `Monitor ${i + 1}`);
  });
}
