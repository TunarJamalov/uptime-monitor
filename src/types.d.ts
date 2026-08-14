declare module 'whois-json' { const lookup: (domain: string, options?: Record<string, unknown>) => Promise<unknown>; export default lookup; }
