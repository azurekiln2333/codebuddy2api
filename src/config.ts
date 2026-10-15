import { isIP } from 'node:net';
import { resolve } from 'node:path';

export interface GatewayConfig {
  publicOrigin: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRefresh: boolean;
  upstreamOrigin: string;
  upstreamApiKey: string;
  host: string;
  port: number;
  uiStaticDir: string;
  allowInsecureLocalhost: boolean;
  sessionTtlMs: number;
  sessionIdleMs: number;
  transactionTtlMs: number;
  maxSessions: number;
  oauthTimeoutMs: number;
  upstreamTimeoutMs: number;
  streamTimeoutMs: number;
  maxBodyBytes: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() !== value || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid or missing ${name}`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`Invalid ${name}`);
  return value === 'true';
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function origin(value: string, name: string, insecure: boolean, allowPath = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/')) {
    throw new Error(`Invalid ${name}`);
  }
  if (url.protocol !== 'https:' && !(insecure && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`${name} requires HTTPS (HTTP only with explicit loopback development opt-in)`);
  }
  return value.replace(/\/$/, '');
}

function privateUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid UPSTREAM_ORIGIN'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid UPSTREAM_ORIGIN');
  }
  const host = url.hostname;
  const ipv4 = host.split('.').map(Number);
  const privateV4 = isIP(host) === 4 && (ipv4[0] === 10 || ipv4[0] === 127 ||
    (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) || (ipv4[0] === 192 && ipv4[1] === 168));
  const privateV6 = /^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host);
  // Fixed Docker service name is resolved only on the private Compose bridge.
  if (!(isLoopback(host) || privateV4 || privateV6 || host === 'codebuddy2api')) {
    throw new Error('UPSTREAM_ORIGIN must be loopback, a private IP, or the private codebuddy2api service');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const allowInsecureLocalhost = bool(env, 'ALLOW_INSECURE_LOCALHOST');
  const publicOrigin = origin(required(env, 'PUBLIC_ORIGIN'), 'PUBLIC_ORIGIN', allowInsecureLocalhost);
  const oidcIssuer = origin(required(env, 'OIDC_ISSUER'), 'OIDC_ISSUER', allowInsecureLocalhost, true);
  const config: GatewayConfig = {
    publicOrigin,
    oidcIssuer,
    oidcClientId: required(env, 'OIDC_CLIENT_ID'),
    oidcClientSecret: required(env, 'OIDC_CLIENT_SECRET'),
    oidcRefresh: bool(env, 'OIDC_REFRESH'),
    upstreamOrigin: privateUpstream(env.UPSTREAM_ORIGIN || 'http://127.0.0.1:8787'),
    upstreamApiKey: required(env, 'UPSTREAM_API_KEY'),
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 8788, 1, 65535),
    uiStaticDir: resolve(env.UI_STATIC_DIR || '../codebuddy2api-ui/dist'),
    allowInsecureLocalhost,
    sessionTtlMs: integer(env, 'SESSION_TTL_MS', 28_800_000, 60_000, 86_400_000),
    sessionIdleMs: integer(env, 'SESSION_IDLE_MS', 1_800_000, 60_000, 86_400_000),
    transactionTtlMs: integer(env, 'TRANSACTION_TTL_MS', 300_000, 10_000, 600_000),
    maxSessions: integer(env, 'MAX_SESSIONS', 1000, 1, 100_000),
    oauthTimeoutMs: integer(env, 'OAUTH_TIMEOUT_MS', 5000, 100, 30_000),
    upstreamTimeoutMs: integer(env, 'UPSTREAM_TIMEOUT_MS', 30_000, 100, 300_000),
    streamTimeoutMs: integer(env, 'STREAM_TIMEOUT_MS', 300_000, 100, 3_600_000),
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 16_777_216, 8192, 67_108_864),
  };
  if (config.sessionIdleMs > config.sessionTtlMs) throw new Error('SESSION_IDLE_MS must not exceed SESSION_TTL_MS');
  return config;
}
