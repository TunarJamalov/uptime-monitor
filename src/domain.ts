import whoisLookup from 'whois-json';
import type { MonitorConfig } from './config.js';

export interface DomainResult { status: 'UP' | 'DOWN'; expirationDate: number | null; daysRemaining: number | null; error?: string; warning?: boolean }
type Lookup = (domain: string, options?: Record<string, unknown>) => Promise<unknown>;
function findDate(value: unknown): number | null {
  if (typeof value === 'string') { const date=Date.parse(value); return Number.isFinite(date) ? date : null; }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(expiration|expiry|paid.?till|renewal)/i.test(key)) { const date=findDate(child); if (date) return date; }
  }
  for (const child of Object.values(value as Record<string, unknown>)) { const date=findDate(child); if (date) return date; }
  return null;
}
export async function checkDomain(monitor: MonitorConfig, lookup: Lookup = whoisLookup as unknown as Lookup): Promise<DomainResult> {
  try { const result=await lookup(monitor.url); const expirationDate=findDate(result); if (!expirationDate) return {status:'DOWN',expirationDate:null,daysRemaining:null,error:'WHOIS response did not contain an expiration date'}; const daysRemaining=Math.ceil((expirationDate-Date.now())/86400000); return {status:daysRemaining >= 0 ? 'UP' : 'DOWN',expirationDate,daysRemaining,warning:daysRemaining <= (monitor.warningThreshold ?? 30)}; } catch(error) { return {status:'DOWN',expirationDate:null,daysRemaining:null,error:error instanceof Error ? error.message : String(error)}; }
}
