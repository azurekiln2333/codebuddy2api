import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { GatewayConfig } from './config.js';
import { AuthService } from './auth.js';
import { GatewayProxy } from './proxy.js';
import { serveStatic } from './static.js';
import { HttpError, json, requireCsrf } from './http.js';

/** Validate before WHATWG URL parsing: both Node and ASGI must classify the same raw path. */
export function validateRequestTarget(target: string, method = 'GET'): void {
  if (!target.startsWith('/') || target.startsWith('//') || /[\x00-\x20\x7f\\#]/.test(target)) {
    throw new HttpError(400, 'invalid_request_target');
  }
  const path = target.split('?')[0]!;
  // Only these original backend routes have a path-valued model identifier.
  // Keep their prefix and preview suffix literal so decoding cannot change
  // classification (notably /admin/%73ession). The UI encodes the complete ID,
  // including its '/', ':' and '@'; ASGI must receive that encoding unchanged.
  const modelPrefix = '/admin/models/';
  let rawModelId: string | undefined;
  if (path.startsWith(modelPrefix)) {
    if (method === 'PUT' || method === 'DELETE') rawModelId = path.slice(modelPrefix.length);
    else if (method === 'POST' && path.endsWith('/preview') && path !== '/admin/models/preview') {
      rawModelId = path.slice(modelPrefix.length, -'/preview'.length);
    }
  }
  if (rawModelId !== undefined) {
    let modelId: string;
    try { modelId = decodeURIComponent(rawModelId); }
    catch { throw new HttpError(400, 'invalid_path'); }
    // Validate after exactly one decode, as ASGI does. This also excludes
    // residual escapes, empty segments, and encoded cross-path dot segments.
    if (!/^[A-Za-z0-9_.:/@-]{1,160}$/.test(modelId) ||
        modelId.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new HttpError(400, 'ambiguous_path');
    }
  }
  const sessionAlias = path.toLowerCase().replace(/\/+$/, '') === '/admin/session' && path !== '/admin/session';
  if (/\/{2,}|(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
      (path.includes('%') && rawModelId === undefined) || sessionAlias) {
    throw new HttpError(400, 'ambiguous_path');
  }
  try {
    decodeURIComponent(path);
    if (new URL(target, 'http://gateway.invalid').pathname !== path) throw new Error('noncanonical');
  } catch { throw new HttpError(400, 'invalid_path'); }
}

function protectResponse(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
}

export function createGateway(config: GatewayConfig): Server {
  const proxy = new GatewayProxy(config);
  const auth = new AuthService(config, (session) => proxy.logout(session));
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    protectResponse(res);
    validateRequestTarget(req.url || '', req.method);
    const url = new URL(req.url!, config.publicOrigin);
    if (url.pathname === '/healthz' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(302, { location: '/dashboard/', 'cache-control': 'no-store' }); res.end(); return;
    }
    if (url.pathname.startsWith('/sso/')) {
      if (await auth.handle(req, res, url)) return;
      throw new HttpError(404, 'not_found');
    }
    if (url.pathname.startsWith('/admin/')) {
      let session;
      try { session = await auth.requireAdmin(req, res); } catch (error) {
        if (url.pathname === '/admin/session' && req.method === 'GET' && error instanceof HttpError && error.status === 401) {
          json(res, 401, { authenticated: false, csrf_token: null }); return;
        }
        throw error;
      }
      if (url.pathname === '/admin/session' && !['GET', 'DELETE'].includes(req.method || '')) {
        throw new HttpError(405, 'method_not_allowed');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') || url.pathname === '/admin/oauth/poll') {
        requireCsrf(req, session, config);
      }
      if (url.pathname === '/admin/session') {
        if (req.method === 'GET') { json(res, 200, { authenticated: true, csrf_token: session.csrfToken }); return; }
        if (req.method === 'DELETE') { await auth.logout(req, res); return; }
        throw new HttpError(405, 'method_not_allowed');
      }
      await proxy.admin(req, res, url, session); return;
    }
    if (url.pathname.startsWith('/v1/')) { await proxy.inference(req, res, url); return; }
    if (await serveStatic(req, res, url, config)) return;
    throw new HttpError(404, 'not_found');
  }
  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      // Never serialize URLs, request data, tokens, raw network errors, or secrets.
      const safe = error instanceof HttpError ? error : new HttpError(502, 'gateway_request_failed');
      json(res, safe.status, { error: safe.code });
    });
  });
  server.requestTimeout = config.streamTimeoutMs;
  server.headersTimeout = Math.min(config.upstreamTimeoutMs, 30_000);
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.on('close', () => { auth.close(); proxy.close(); });
  return server;
}
