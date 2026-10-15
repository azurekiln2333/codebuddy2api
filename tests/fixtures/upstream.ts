import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Faithful in-memory anti-double of the original CodeBuddy management API.
 *
 * It reproduces the security-relevant behaviour the gateway must bridge to:
 *
 *  - POST /admin/session requires an exact legal Origin AND the server api_key,
 *    then issues an opaque cookie (cb_admin_session) plus a non-empty CSRF,
 *  - the admin cookie is scoped to /admin with SameSite=strict,
 *  - mutating /admin routes require Origin + X-CSRF-Token,
 *  - GET /admin/oauth/poll also requires CSRF (it changes account state),
 *  - POST /admin/logs/clear scope=all requires the exact confirmation text AND
 *    the api_key in the body,
 *  - unknown /admin routes 404,
 *  - /v1/* enforces caller Bearer / X-Api-Key against a caller key and never
 *    accepts the server key,
 *  - /v1/stream emits SSE chunks so streaming/cancellation can be asserted.
 *
 * Every request increments per-route counters so tests can prove the upstream
 * was (or was not) reached. Totally synthetic; no real backend involved.
 */

export interface UpstreamControls {
  /** Delay /v1/stream first byte to simulate a slow upstream. */
  streamDelayMs: number;
  /** Reject /admin/session login (wrong server key scenario). */
  rejectLogin: boolean;
  /** Treat the admin session as revoked; all admin calls 401. */
  revoked: boolean;
  /** Emit Connection-nominated hop-by-hop headers on /v1 responses. */
  hopByHopResponseHeaders: boolean;
  /** Emit a Set-Cookie header on /v1 responses. */
  setCookieOnInference: boolean;
}

export interface UpstreamServer {
  origin: string;
  port: number;
  apiKey: string;
  callerKey: string;
  controls: UpstreamControls;
  server: Server;
  /** Exact URL paths reached, in order. */
  requests: string[];
  /** Count of requests per pathname. */
  counts: Record<string, number>;
  /** Bodies observed on mutation routes. */
  lastBodies: Record<string, unknown>;
  /** Raw headers observed on the last request per pathname. */
  lastHeaders: Record<string, Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
  reset(): void;
}

const CLEAR_CONFIRMATION = "清空全部日志与统计";
const ADMIN_COOKIE = "cb_admin_session";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function startUpstream(options?: {
  apiKey?: string;
  callerKey?: string;
}): Promise<UpstreamServer> {
  const apiKey = options?.apiKey ?? "server-api-key-abc";
  const callerKey = options?.callerKey ?? "caller-token-xyz";

  const controls: UpstreamControls = { streamDelayMs: 0, rejectLogin: false, revoked: false, hopByHopResponseHeaders: false, setCookieOnInference: false };
  const sessions = new Map<string, { csrf: string; origin: string }>();
  const requests: string[] = [];
  const counts: Record<string, number> = {};
  const lastBodies: Record<string, unknown> = {};
  const lastHeaders: Record<string, Record<string, string | string[] | undefined>> = {};

  const server = createServer((req, res) => {
    // Deliberately emit CORS headers so suppression assertions are non-vacuous.
    res.setHeader("access-control-allow-origin", "https://untrusted.example");
    res.setHeader("access-control-allow-credentials", "true");
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // ASGI servers (uvicorn/starlette) decode percent-encoding into
      // scope["path"] before routing, so the anti-double must do the same to be
      // faithful. We record BOTH the raw target and the decoded path: the raw
      // target proves what the gateway sent, the decoded path proves which
      // ASGI route it would actually hit.
      const rawTarget = req.url ?? "/";
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        path = url.pathname;
      }
      requests.push(rawTarget);
      counts[path] = (counts[path] ?? 0) + 1;
      // Keep the raw-target counter too, under a distinct key.
      counts[`raw:${rawTarget}`] = (counts[`raw:${rawTarget}`] ?? 0) + 1;
      lastHeaders[path] = req.headers;

      const readText = async (): Promise<string> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      };
      const readJson = async (): Promise<Record<string, unknown>> => {
        const text = await readText();
        if (!text) return {};
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return {};
        }
      };

      const cookie = (name: string): string => {
        const header = req.headers.cookie ?? "";
        for (const part of header.split(";")) {
          const [k, ...rest] = part.trim().split("=");
          if (k === name) return rest.join("=");
        }
        return "";
      };

      const sessionFromCookie = (): { sid: string; csrf: string; origin: string } | null => {
        const sid = cookie(ADMIN_COOKIE);
        const found = sessions.get(sid);
        if (!found) return null;
        return { sid, ...found };
      };

      // ---- POST /admin/session ------------------------------------------
      if (path === "/admin/session" && req.method === "POST") {
        if (controls.rejectLogin) {
          json(res, 401, { error: "API key 无效" });
          return;
        }
        const body = await readJson();
        lastBodies[path] = body;
        // The upstream only accepts a well-formed http(s) Origin; the gateway
        // must forward the canonical backend origin, never the browser's.
        let origin = "";
        try {
          origin = new URL(String(req.headers.origin ?? "")).origin;
        } catch {
          origin = "";
        }
        if (!origin.startsWith("http")) {
          json(res, 403, { error: "Origin 校验失败" });
          return;
        }
        if (typeof body.api_key !== "string" || !safeEqual(body.api_key, apiKey)) {
          json(res, 401, { error: "API key 无效" });
          return;
        }
        const sid = randomBytes(24).toString("hex");
        const csrf = randomBytes(24).toString("hex");
        sessions.set(sid, { csrf, origin });
        res.setHeader("set-cookie", `${ADMIN_COOKIE}=${sid}; Path=/admin; HttpOnly; SameSite=Strict`);
        json(res, 200, { authenticated: true, csrf_token: csrf });
        return;
      }

      // ---- GET /admin/session -------------------------------------------
      if (path === "/admin/session" && req.method === "GET") {
        const found = controls.revoked ? null : sessionFromCookie();
        json(res, 200, { authenticated: Boolean(found), csrf_token: found?.csrf ?? null });
        return;
      }

      // ---- DELETE /admin/session ----------------------------------------
      if (path === "/admin/session" && req.method === "DELETE") {
        const found = sessionFromCookie();
        if (found) sessions.delete(found.sid);
        res.setHeader("set-cookie", `${ADMIN_COOKIE}=; Path=/admin; Max-Age=0`);
        json(res, 200, { authenticated: false });
        return;
      }

      // ---- /admin/* shared authorization --------------------------------
      if (path.startsWith("/admin/")) {
        const found = controls.revoked ? null : sessionFromCookie();
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
        const keyAuth = safeEqual(bearer, apiKey) || safeEqual(String(req.headers["x-api-key"] ?? ""), apiKey);
        if (!found && !keyAuth) {
          json(res, 401, { error: "管理认证无效或会话已过期" });
          return;
        }
        // Mutations (and oauth poll) require Origin + CSRF when cookie-authed.
        const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") || path === "/admin/oauth/poll";
        if (found && mutating) {
          const origin = String(req.headers.origin ?? "");
          const supplied = String(req.headers["x-csrf-token"] ?? "");
          if (!origin || !safeEqual(supplied, found.csrf)) {
            json(res, 403, { error: "Origin 或 CSRF 校验失败" });
            return;
          }
        }

        if (path === "/admin/oauth/poll" && req.method === "GET") {
          json(res, 200, { done: false });
          return;
        }

        if (path === "/admin/logs/clear" && req.method === "POST") {
          const body = await readJson();
          lastBodies[path] = body;
          if (body.scope === "all") {
            if (body.confirmation !== CLEAR_CONFIRMATION || !safeEqual(String(body.api_key ?? ""), apiKey)) {
              json(res, 403, { error: "全部清理需要确认文本及当前 API key" });
              return;
            }
          }
          json(res, 200, { ok: true, scope: body.scope });
          return;
        }

        if (path === "/admin/dashboard" && req.method === "GET") {
          json(res, 200, { generated_at: 0, health: { credentials: [] } });
          return;
        }

        if (path === "/admin/settings" && req.method === "GET") {
          json(res, 200, { revision: 1, items: [] });
          return;
        }

        json(res, 404, { error: "not_found" });
        return;
      }

      // ---- /v1/* inference ----------------------------------------------
      if (path.startsWith("/v1/")) {
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
        const supplied = bearer || String(req.headers["x-api-key"] ?? "");
        if (!supplied || !safeEqual(supplied, callerKey) || safeEqual(supplied, apiKey)) {
          json(res, 401, { error: "无效的调用凭证" });
          return;
        }
        if (controls.hopByHopResponseHeaders) {
          // A Connection header that nominates a custom header: the gateway must
          // strip BOTH the Connection header and the nominated one.
          res.setHeader("connection", "x-upstream-hop");
          res.setHeader("x-upstream-hop", "should-not-be-relayed");
        }
        if (controls.setCookieOnInference) {
          res.setHeader("set-cookie", "upstream=inference-should-not-leak; Path=/");
        }
        if (["/v1/stream", "/v1/stream-post", "/v1/stream-finite"].includes(path) && (req.method === "GET" || req.method === "POST")) {
          if (controls.streamDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, controls.streamDelayMs));
          }
          if (res.destroyed) return;
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream");
          res.setHeader("cache-control", "no-cache");
          res.write("data: first\n\n");
          // Emit more chunks slowly; honor client abort.
          let ticks = 0;
          const timer = setInterval(() => {
            if (res.writableEnded) {
              clearInterval(timer);
              return;
            }
            res.write("data: tick\n\n");
            if (path === "/v1/stream-finite" && ++ticks === 4) {
              counts[`completed:${path}`] = (counts[`completed:${path}`] ?? 0) + 1;
              res.end("data: done\n\n");
              clearInterval(timer);
            }
          }, 20);
          res.on("close", () => {
            clearInterval(timer);
            if (!res.writableFinished) counts[`cancelled:${path}`] = (counts[`cancelled:${path}`] ?? 0) + 1;
          });
          return;
        }
        if (path === "/v1/echo" && req.method === "POST") {
          const body = await readText();
          json(res, 200, { ok: true, echo: body, headers: { authorization: req.headers.authorization ?? "" } });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    apiKey,
    callerKey,
    controls,
    server,
    requests,
    counts,
    lastBodies,
    lastHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    reset: () => {
      requests.length = 0;
      for (const key of Object.keys(counts)) delete counts[key];
      for (const key of Object.keys(lastBodies)) delete lastBodies[key];
      for (const key of Object.keys(lastHeaders)) delete lastHeaders[key];
      sessions.clear();
      Object.assign(controls, { streamDelayMs: 0, rejectLogin: false, revoked: false, hopByHopResponseHeaders: false, setCookieOnInference: false });
    },
  };
}
