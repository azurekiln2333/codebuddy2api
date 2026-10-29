import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.js";
import { HttpError } from "./http.js";
import type { GatewaySession } from "./sessions.js";

/**
 * Backend bridge for /admin/* and /v1/*.
 *
 * The gateway never exposes the private FastAPI listener and never lets the
 * browser hold an upstream credential. For every gateway session we establish
 * an independent upstream admin session (cookie + CSRF) using the server
 * api_key and a canonical backend Origin. Browser auth/cookie/CSRF/identity
 * headers are stripped before forwarding and the upstream Set-Cookie response
 * is never relayed to the browser.
 */

/** Exact confirmation text required by the upstream full-log wipe route. */
export const CLEAR_CONFIRMATION = "清空全部日志与统计";

const ADMIN_SESSION_PATH = "/admin/session";
const CLEAR_LOG_PATH = "/admin/logs/clear";
const MAX_FILTER_BYTES = 65536;

/**
 * Browser-supplied identity/bridge headers that must never cross into the
 * upstream trusted scope. Caller inference credentials (`authorization`,
 * `x-api-key`) are intentionally NOT here: the inference route preserves them
 * explicitly, while the admin route strips them via the same set below.
 *
 * `x-forwarded-*` / `x-real-ip` / `x-auth-request-*` / `remote-user` are
 * spoofable identity assertions: an untrusted client must never be able to
 * impersonate a proxy-authenticated user to the backend.
 */
const IDENTITY_REQUEST_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-forwarded-prefix",
  "x-forwarded-uri",
  "x-real-ip",
  "x-client-ip",
  "x-originating-ip",
  "x-remote-ip",
  "x-remote-addr",
  "x-cluster-client-ip",
  "x-auth-request-user",
  "x-auth-request-email",
  "x-auth-request-groups",
  "x-auth-request-preferred-username",
  "x-auth-request-access-token",
  "x-auth-request-id-token",
  "remote-user",
  "x-remote-user",
  "x-authenticated-user",
  "x-authenticated-userid",
  "x-admin-identity",
  "x-cb-admin",
  "x-user-id",
  "x-user-role",
  "x-forwarded-user",
] as const;

/** Browser-supplied headers that must never cross into the upstream trusted scope. */
const STRIP_REQUEST_HEADERS = new Set<string>([
  "authorization",
  "x-api-key",
  "cookie",
  "x-csrf-token",
  "origin",
  "referer",
  "referrer",
  ...IDENTITY_REQUEST_HEADERS,
]);

/**
 * Upstream response headers that must never be relayed. Always-hop-by-hop names
 * are handled separately by HOP_BY_HOP, so this set holds only the
 * cookie/CORS/privacy headers.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "content-security-policy-report-only",
]);

/** Always hop-by-hop, regardless of a Connection header nomination (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Collect the lowercased header names nominated by a `Connection:` header.
 * Those connection options are hop-by-hop for this single hop and must be
 * removed before forwarding (e.g. `Connection: x-custom-hop`).
 */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const tokens = new Set<string>();
  const raw = headers.connection;
  for (const value of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    for (const part of String(value).split(",")) {
      const name = part.trim().toLowerCase();
      if (name) tokens.add(name);
    }
  }
  return tokens;
}

/** Match identity header families as well as the explicit compatibility names. */
function isIdentityHeader(name: string): boolean {
  return (IDENTITY_REQUEST_HEADERS as readonly string[]).includes(name) ||
    /^(?:x-forwarded-|x-auth-request-|x-authenticated-|x-user-|x-remote-)/.test(name);
}

type UpstreamSession = { cookie: string; csrfToken: string };

interface SessionBridge extends GatewaySession {
  upstream?: UpstreamSession;
  upstreamLogin?: Promise<void>;
  refreshPromise?: Promise<void>;
}

/** Parse a Set-Cookie attribute string for the admin session cookie. */
function extractAdminCookie(setCookie: string[]): string | null {
  for (const raw of setCookie) {
    const pair = raw.split(";", 1)[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "cb_admin_session") return pair;
  }
  return null;
}

/** Collect a bounded request body, aborting the socket past the limit. */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish(new HttpError(413, "request_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish());
    req.on("error", (err) => finish(err instanceof Error ? err : new Error("request stream error")));
    req.on("aborted", () => finish(new HttpError(499, "client_closed_request")));
  });
}

/**
 * Establish and cache the upstream admin session for a gateway session.
 * Synchronized through session.upstreamLogin so concurrent first requests
 * trigger exactly one backend login.
 */
async function ensureUpstreamSession(config: GatewayConfig, session: SessionBridge): Promise<UpstreamSession> {
  if (session.upstream) return session.upstream;
  if (session.upstreamLogin) {
    await session.upstreamLogin;
    if (session.upstream) return session.upstream;
    throw new HttpError(502, "upstream_login_failed");
  }
  const login = (async (): Promise<void> => {
    const body = JSON.stringify({ api_key: config.upstreamApiKey });
    const result = await upstreamFetch(config, ADMIN_SESSION_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: config.upstreamOrigin,
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs: config.upstreamTimeoutMs,
    });
    if (result.status !== 200) {
      throw new HttpError(502, "upstream_login_failed");
    }
    const cookie = extractAdminCookie(result.setCookie);
    let csrf = "";
    try {
      const parsed = JSON.parse(result.body.toString("utf8")) as { csrf_token?: unknown };
      csrf = typeof parsed.csrf_token === "string" ? parsed.csrf_token : "";
    } catch {
      csrf = "";
    }
    if (!cookie || !csrf) throw new HttpError(502, "upstream_login_incomplete");
    session.upstream = { cookie, csrfToken: csrf };
  })();
  session.upstreamLogin = login;
  try {
    await login;
  } finally {
    delete session.upstreamLogin;
  }
  if (!session.upstream) throw new HttpError(502, "upstream_login_failed");
  return session.upstream;
}

interface UpstreamResult {
  status: number;
  headers: IncomingHttpHeaders;
  setCookie: string[];
  body: Buffer;
}

/**
 * One-shot upstream request that buffers the full response (bounded routes only).
 *
 * An absolute deadline covers connect + request + the entire response body, so a
 * slow upstream that trickles bytes forever cannot pin a buffered admin request.
 * When `signal` aborts (downstream client went away) the upstream socket is
 * destroyed immediately.
 */
function upstreamFetch(
  config: GatewayConfig,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer | string; timeoutMs: number; signal?: AbortSignal; maxBytes?: number },
): Promise<UpstreamResult> {
  const maxBytes = init.maxBytes ?? MAX_FILTER_BYTES * 64;
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.upstreamOrigin);
    const requestFn = upstreamRequestFn(config);
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (deadline) clearTimeout(deadline);
      init.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy(err as Error);
      reject(err);
    };
    const onAbort = (): void => fail(new HttpError(499, "client_closed_request"));

    const options: RequestOptions = { method: init.method, headers: init.headers };
    const req = requestFn(url, options, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail(new HttpError(502, "upstream_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const setCookie = res.headers["set-cookie"];
        resolve({
          status: res.statusCode ?? 502,
          headers: res.headers,
          setCookie: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", (err) => fail(err instanceof HttpError ? err : new HttpError(502, "upstream_unavailable")));
    });

    // Absolute deadline for the whole exchange, including the response body.
    deadline = setTimeout(() => fail(new HttpError(504, "upstream_timeout")), init.timeoutMs);
    deadline.unref?.();
    if (init.signal) {
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", (err) => fail(err instanceof HttpError ? err : new HttpError(502, "upstream_unavailable")));
    if (init.body !== undefined) req.end(init.body);
    else req.end();
  });
}

/** Copy upstream response headers minus hop-by-hop, Connection-nominated,
 * cookie and CORS headers. */
function copyResponseHeaders(headers: IncomingHttpHeaders, res: ServerResponse): void {
  const nominated = connectionTokens(headers);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower) || HOP_BY_HOP.has(lower) || nominated.has(lower)) continue;
    if (lower === "content-length") continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) res.appendHeader(name, item);
    } else {
      res.setHeader(name, value);
    }
  }
}

/** The upstream transport chosen from the configured origin protocol (fix 3). */
function upstreamRequestFn(config: GatewayConfig) {
  return new URL(config.upstreamOrigin).protocol === "https:" ? httpsRequest : httpRequest;
}

/**
 * Copy a browser request header set into a safe outbound set, applying the
 * caller-supplied `skip` predicate plus the always-hop-by-hop / identity rules.
 * `Connection`-nominated headers are dropped too, since those tokens are
 * hop-by-hop for this hop (fix 2).
 */
function copyForwardableHeaders(
  source: IncomingHttpHeaders,
  skip: (lower: string) => boolean = () => false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const nominated = connectionTokens(source);
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length") continue;
    if (HOP_BY_HOP.has(lower) || nominated.has(lower) || isIdentityHeader(lower)) continue;
    if (skip(lower)) continue;
    if (value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/** Build the safe outbound header set for a proxied admin request. */
function buildAdminHeaders(
  req: IncomingMessage,
  config: GatewayConfig,
  upstream: UpstreamSession,
  mutation: boolean,
  contentLength?: number,
): Record<string, string> {
  // Admin bridge: strip all browser identity/auth/cookie headers.
  const headers = copyForwardableHeaders(req.headers, (lower) => STRIP_REQUEST_HEADERS.has(lower));
  headers["host"] = new URL(config.upstreamOrigin).host;
  headers["origin"] = config.upstreamOrigin;
  headers["cookie"] = upstream.cookie;
  if (mutation) headers["x-csrf-token"] = upstream.csrfToken;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return headers;
}

/** Routes that mutate upstream state and therefore require the real upstream CSRF. */
function isAdminMutation(method: string, pathname: string): boolean {
  if (pathname === "/admin/oauth/poll") return true;
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

async function forwardBufferedAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  path: string,
  pathname: string,
  session: SessionBridge,
): Promise<void> {
  let upstream = await ensureUpstreamSession(config, session);
  const mutation = isAdminMutation(req.method ?? "GET", pathname);
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  // Downstream cancellation: if the browser disconnects while the upstream is
  // still working, abort the upstream request instead of waiting for the
  // absolute deadline. `res.close` fires on client disconnect and after a
  // finished response; the `settled`-style guard below ignores the latter.
  const controller = new AbortController();
  const onClientGone = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClientGone);

  try {
    let bodyBuf: Buffer | undefined;
    if (hasBody) {
      bodyBuf = await readRawBody(req, config.maxBodyBytes);

      // Full log clear: the browser sends scope=all + confirmation but no key.
      // Validate the exact text, then inject the server api_key. Never forward a
      // browser-supplied api_key for this route.
      if (pathname === CLEAR_LOG_PATH) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
        } catch {
          throw new HttpError(400, "invalid_json");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new HttpError(400, "invalid_json_object");
        }
        if (parsed.scope === "all") {
          if (parsed.confirmation !== CLEAR_CONFIRMATION) {
            throw new HttpError(403, "confirmation_required");
          }
          if ("api_key" in parsed) delete parsed.api_key;
          parsed.api_key = config.upstreamApiKey;
          bodyBuf = Buffer.from(JSON.stringify(parsed));
        } else {
          // details-only clear does not need the key; drop any browser key anyway.
          if ("api_key" in parsed) {
            delete parsed.api_key;
            bodyBuf = Buffer.from(JSON.stringify(parsed));
          }
        }
      }
    }

    const send = (bridge: UpstreamSession): Promise<UpstreamResult> => {
      const headers = buildAdminHeaders(req, config, bridge, mutation, bodyBuf?.length);
      return upstreamFetch(config, path, {
        method,
        headers,
        body: bodyBuf,
        timeoutMs: config.upstreamTimeoutMs,
        signal: controller.signal,
      });
    };

    let result = await send(upstream);

    // Fix 4: if the cached upstream bridge session was revoked/expired, clear it
    // so the next request re-establishes a fresh bridge. Never retry a mutation
    // (the upstream may have applied it); surface the 401 so the browser can
    // re-authenticate. GET/HEAD/OPTIONS are safe to retry exactly once with a
    // freshly established bridge.
    if (result.status === 401) {
      delete session.upstream;
      if (!mutation) {
        upstream = await ensureUpstreamSession(config, session);
        result = await send(upstream);
      }
    }

    copyResponseHeaders(result.headers, res);
    res.setHeader("cache-control", "no-store");
    res.setHeader("pragma", "no-cache");
    res.setHeader("content-length", String(result.body.length));
    res.statusCode = result.status;
    res.end(result.body);
  } catch (error) {
    if (!res.headersSent && !res.writableEnded) {
      const safe = error instanceof HttpError ? error : new HttpError(502, "upstream_unavailable");
      res.statusCode = safe.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ error: safe.code }));
      return;
    }
    if (!res.writableEnded) res.destroy();
  } finally {
    res.off("close", onClientGone);
  }
}

/**
 * Stream a proxied request without buffering, preserving SSE flush semantics,
 * backpressure and client cancellation.
 *
 * Fix 1: `req` emits `close` after a normally completed request body (even on a
 * healthy keep-alive GET/POST), so listening on `req.close` aborted perfectly
 * good requests. Client disconnect is detected via `res.close` (fires when the
 * connection is terminated or the response finishes) plus `req.aborted` (the
 * request stream was aborted before the body completed).
 */
function forwardStream(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  path: string,
  init: { headers: Record<string, string>; method: string; timeoutMs: number; body?: Buffer },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.upstreamOrigin);
    let settled = false;
    let upstreamRes: IncomingMessage | null = null;
    let finished = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      res.off("close", onClientGone);
      req.off("aborted", onClientGone);
      resolve();
    };
    const onClientGone = (): void => {
      // Only a truly unfinished response means the client went away. `res.close`
      // also fires after a normal completion, which `finished` distinguishes.
      if (!finished) {
        upstreamRes?.destroy();
        proxy.destroy();
      }
      cleanup();
    };

    const proxy = upstreamRequestFn(config)(
      url,
      { method: init.method, headers: init.headers, timeout: init.timeoutMs },
      (upstream) => {
        upstreamRes = upstream;
        copyResponseHeaders(upstream.headers, res);
        // Flush headers immediately so SSE clients see the event stream open.
        res.statusCode = upstream.statusCode ?? 502;
        res.flushHeaders();
        upstream.pipe(res);
        upstream.on("end", () => {
          finished = true;
          if (!res.writableEnded) res.end();
          cleanup();
        });
        upstream.on("error", () => {
          if (!res.headersSent) res.destroy();
          else res.destroy();
          cleanup();
        });
      },
    );

    proxy.on("timeout", () => {
      proxy.destroy(new HttpError(504, "upstream_timeout"));
    });
    proxy.on("error", (err) => {
      if (!res.headersSent) reject(err instanceof HttpError ? err : new HttpError(502, "upstream_unavailable"));
      else res.destroy();
      cleanup();
    });
    res.on("close", onClientGone);
    req.on("aborted", onClientGone);

    if (init.body !== undefined) proxy.end(init.body);
    else req.pipe(proxy);
  });
}

export class GatewayProxy {
  constructor(private readonly config: GatewayConfig) {}

  /** Proxy an authenticated, gateway-CSRF-validated /admin/* request. */
  async admin(req: IncomingMessage, res: ServerResponse, url: URL, session: GatewaySession): Promise<void> {
    const bridge = session as SessionBridge;
    const path = url.pathname + (url.search ?? "");
    await forwardBufferedAdmin(req, res, this.config, path, url.pathname, bridge);
  }

  /** Proxy /v1/* keeping only caller credentials; never inject server secrets or cookies. */
  async inference(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Preserve ONLY caller inference credentials (Bearer / X-Api-Key); every
    // cookie, browser identity header, hop-by-hop header and Connection-
    // nominated header is dropped. No server secret is ever injected.
    const headers = copyForwardableHeaders(
      req.headers,
      (lower) =>
        lower === "cookie" || (STRIP_REQUEST_HEADERS.has(lower) && lower !== "authorization" && lower !== "x-api-key"),
    );
    headers["host"] = new URL(this.config.upstreamOrigin).host;
    headers["origin"] = this.config.upstreamOrigin;
    // No cookie, no upstream api_key, no CSRF, no server secret.
    const path = url.pathname + (url.search ?? "");
    await forwardStream(req, res, this.config, path, {
      method: req.method ?? "GET",
      headers,
      timeoutMs: this.config.streamTimeoutMs,
    });
  }

  /** Best-effort upstream session revocation when a gateway session ends. */
  async logout(session: GatewaySession): Promise<void> {
    const bridge = session as SessionBridge;
    const upstream = bridge.upstream;
    delete bridge.upstream;
    delete bridge.upstreamLogin;
    if (!upstream) return;
    try {
      await upstreamFetch(this.config, ADMIN_SESSION_PATH, {
        method: "DELETE",
        headers: {
          cookie: upstream.cookie,
          origin: this.config.upstreamOrigin,
          "x-csrf-token": upstream.csrfToken,
        },
        timeoutMs: this.config.upstreamTimeoutMs,
      });
    } catch {
      // Logout must still succeed locally; the upstream session expires on its own.
    }
  }

  close(): void {
    // Stateless manager: nothing persistent to release. Per-session upstream
    // references are dropped as sessions are evicted by the auth layer.
  }
}
