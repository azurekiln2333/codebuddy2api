import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { resolve } from "node:path";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * Integration against the ACTUAL original FastAPI backend.
 *
 * Spawns D:/My2KProjects/codebuddy2api (read-only) through a disposable
 * launcher with all writable state and bytecode outside the reference repo,
 * then points the gateway at it as the private upstream. This proves the real
 * bridge login, Origin + api_key handling, CSRF translation, log-clear
 * confirmation injection and admin authorization against the original code.
 *
 * If the isolated Python venv is missing, the test reports the exact limitation
 * instead of silently passing.
 */

const VENV_PYTHON = resolve(".tmp/backend-venv/Scripts/python.exe");
const REFERENCE_ROOT = process.env.CODEBUDDY2API_REF ?? "D:/My2KProjects/codebuddy2api";

interface BackendHandle {
  process: ChildProcessWithoutNullStreams;
  origin: string;
  apiKey: string;
  stderr: string[];
}

function startBackend(): Promise<BackendHandle> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      VENV_PYTHON,
      [resolve("tests/backend/server_fixture.py")],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          CODEBUDDY2API_REF: REFERENCE_ROOT,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONPYCACHEPREFIX: resolve(".tmp/pycache"),
          BACKEND_FIXTURE_API_KEY: "fixture-server-key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;

    const stderr: string[] = [];
    let buffer = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`backend fixture did not report a port within 45s. stderr:\n${stderr.join("")}`));
    }, 45_000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as { port: number; apiKey: string; origin: string };
        clearTimeout(timeout);
        resolvePromise({ process: child, origin: parsed.origin, apiKey: parsed.apiKey, stderr });
      } catch {
        clearTimeout(timeout);
        child.kill();
        reject(new Error(`unexpected backend handshake: ${line}`));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`backend exited early (code ${code}). stderr:\n${stderr.join("")}`));
    });
  });
}

describe("original FastAPI backend integration", () => {
  let backend: BackendHandle | null = null;
  let idp: MockOAuthProvider;
  let gw: RunningGateway;
  let unavailable: string | null = null;

  before(async () => {
    if (!existsSync(VENV_PYTHON)) {
      unavailable =
        `isolated backend venv missing at ${VENV_PYTHON}; ` +
        `create it with: python -m venv .tmp/backend-venv && .tmp/backend-venv/Scripts/python -m pip install fastapi httpx python-dotenv "uvicorn[standard]"`;
      return;
    }
    if (!existsSync(REFERENCE_ROOT)) {
      unavailable = `reference backend not found at ${REFERENCE_ROOT}`;
      return;
    }
    idp = await startMockOAuth();
    try {
      backend = await startBackend();
    } catch (error) {
      unavailable = `failed to start original backend: ${(error as Error).message}`;
      return;
    }
    const { realBackendConfig } = await import("./helpers/config.js");
    gw = await startGateway((publicOrigin, port) => realBackendConfig(idp, backend!, { publicOrigin, port }));
  });

  after(async () => {
    await gw?.close();
    await idp?.close();
    if (backend) {
      backend.process.stdin.end();
      backend.process.kill();
    }
  });

  function requireBackend(): void {
    if (unavailable) {
      throw new Error(`original backend integration unavailable: ${unavailable}`);
    }
  }

  it("logs into the real backend through the gateway bridge", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 200, `real /admin/dashboard: ${res.body.slice(0, 300)}`);
  });

  it("does not expose the real backend Set-Cookie to the browser", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/dashboard");
    assert.equal(res.setCookie.length, 0);
    assert.ok(!client.cookies.has("cb_admin_session"));
  });

  it("reads real storage accounting and archives without exposing the backend cookie", async (t) => {
    requireBackend();
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/storage");
    assert.equal(res.status, 200, res.body);
    const storage = client.json<Record<string, unknown>>(res);
    for (const field of ["db_bytes", "wal_bytes", "shm_bytes", "logical_bytes", "max_bytes", "reclaimable_bytes", "retention_days"]) {
      assert.equal(typeof storage[field], "number", `${field} must be numeric`);
      assert.ok(Number.isFinite(storage[field]) && Number(storage[field]) >= 0, `${field} must be finite and nonnegative`);
    }
    assert.ok(Array.isArray(storage.archives));
    assert.ok(storage.archives.every((file) => typeof file === "string"));
    assert.equal(storage.degraded, false);
    assert.equal(res.setCookie.length, 0);
    assert.ok(!client.cookies.has("cb_admin_session"));
    t.diagnostic(`GET /admin/storage ${res.status}: ${res.body}`);
  });

  it("archives real storage with the UI's 30-day request through the CSRF bridge", async (t) => {
    requireBackend();
    const { client } = await login(gw, idp);
    const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post("/admin/storage/archive", { days: 30 }, {
      headers: { origin: gw.origin, "x-csrf-token": session.csrf_token },
    });
    assert.equal(res.status, 200, res.body);
    // Isolated fixture records are recent; empty archives succeed without a file.
    assert.deepEqual(client.json(res), { ok: true, archived_requests: 0, archived_events: 0, file: null });
    assert.equal(res.setCookie.length, 0);
    t.diagnostic(`POST /admin/storage/archive ${res.status}: ${res.body}`);
  });

  it("preserves the real storage archive validation error for zero days", async (t) => {
    requireBackend();
    const { client } = await login(gw, idp);
    const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post("/admin/storage/archive", { days: 0 }, {
      headers: { origin: gw.origin, "x-csrf-token": session.csrf_token },
    });
    assert.equal(res.status, 400, res.body);
    assert.deepEqual(client.json(res), {
      error: { message: "请求参数、配置或策略无效，请检查类型、范围及冲突", type: "admin_error" },
    });
    t.diagnostic(`POST /admin/storage/archive days=0 ${res.status}: ${res.body}`);
  });

  it("performs a real full-log clear with confirmation through the bridge", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post(
      "/admin/logs/clear",
      { scope: "all", confirmation: "清空全部日志与统计" },
      { headers: { origin: gw.origin, "x-csrf-token": session.csrf_token } },
    );
    assert.ok(res.status === 200, `real clear: ${res.status} ${res.body.slice(0, 300)}`);
  });

  it("rejects a full-log clear with the wrong confirmation against the real backend", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post(
      "/admin/logs/clear",
      { scope: "all", confirmation: "nope" },
      { headers: { origin: gw.origin, "x-csrf-token": session.csrf_token } },
    );
    assert.equal(res.status, 403);
  });

  it("rejects /v1 inference without the real caller key", async () => {
    requireBackend();
    const res = await gw.client.get("/v1/models");
    assert.equal(res.status, 401, "real backend rejects an unauthenticated /v1 call");
    assertInferenceHeaders(res.headers, {});
  });

  function assertInferenceHeaders(headers: import("node:http").IncomingHttpHeaders, sent: { authorization?: string; apiKey?: string }): void {
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    assert.equal(headers["x-fixture-cookie-present"], "false", "real backend must receive no browser or upstream cookie");
    assert.equal(headers["x-fixture-auth-sha256"], hash(sent.authorization ?? ""));
    assert.equal(headers["x-fixture-key-sha256"], hash(sent.apiKey ?? ""));
  }

  for (const header of ["authorization", "x-api-key"]) {
    it(`rejects a wrong ${header} without replacing it with the server key`, async () => {
      requireBackend();
      const value = header === "authorization" ? "Bearer wrong-caller-key" : "wrong-caller-key";
      const res = await gw.client.get("/v1/models", { headers: { [header]: value } });
      assert.equal(res.status, 401);
      assertInferenceHeaders(res.headers, header === "authorization" ? { authorization: value } : { apiKey: value });
    });
  }

  it("rejects inference with only a gateway admin session cookie", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    assert.equal((await client.get("/admin/dashboard")).status, 200, "a real upstream bridge exists");
    const res = await client.get("/v1/models");
    assert.equal(res.status, 401);
    assertInferenceHeaders(res.headers, {});
  });

  for (const header of ["authorization", "x-api-key"]) {
    it(`accepts an explicit correct caller ${header} with no cookies or extra credential`, async () => {
      requireBackend();
      const value = header === "authorization" ? `Bearer ${backend!.apiKey}` : backend!.apiKey;
      const res = await gw.client.get("/v1/models", { headers: {
        [header]: value, cookie: "cb_gateway_session=browser; cb_admin_session=upstream-spoof",
      } });
      assert.equal(res.status, 200, res.body);
      assert.equal(gw.client.json<{ object: string }>(res).object, "list");
      assertInferenceHeaders(res.headers, header === "authorization" ? { authorization: value } : { apiKey: value });
    });
  }

  it("preserves real account OAuth start/poll ownership, gateway CSRF and credential save", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const headers = { origin: gw.origin, "x-csrf-token": session.csrf_token };
    assert.equal((await client.post("/admin/oauth/start?site=cn", {})).status, 403);
    const started = await client.post("/admin/oauth/start?site=cn", {}, { headers });
    assert.equal(started.status, 200, started.body);
    const task = client.json<{ login_id: string; verification_uri: string }>(started);
    assert.equal(new URL(task.verification_uri).origin, "https://www.codebuddy.cn");
    const poll = `/admin/oauth/poll?login_id=${encodeURIComponent(task.login_id)}`;
    assert.equal((await client.get(poll)).status, 403, "poll requires gateway CSRF");
    assert.deepEqual(client.json(await client.get(poll, { headers })), { done: false });
    const other = await login(gw, idp, { client: new HttpClient({ host: gw.host, port: gw.port }) });
    const otherSession = other.client.json<{ csrf_token: string }>(await other.client.get("/sso/session"));
    const forbidden = await other.client.get(poll, { headers: { origin: gw.origin, "x-csrf-token": otherSession.csrf_token } });
    assert.equal(forbidden.status, 404, "one gateway session cannot poll another's account task");
    const complete = await client.get(poll, { headers });
    assert.equal(complete.status, 200, complete.body);
    const saved = client.json<{ done: boolean; uid: string; imported: string }>(complete);
    assert.equal(saved.done, true);
    assert.equal(saved.uid, "fixture-account");
    assert.match(saved.imported, /\.info$/);
    assert.ok(!complete.body.includes("synthetic-account-token"));
    assert.deepEqual(client.json(await client.get(poll, { headers })), saved, "repeated poll reuses the saved result");
  });

  it("creates a real custom model and preserves its encoded generated ID through preview, update and delete", async () => {
    requireBackend();
    const { client } = await login(gw, idp);
    const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const headers = { origin: gw.origin, "x-csrf-token": session.csrf_token, "content-type": "application/json" };
    const inventory = client.json<{ revision: number }>(await client.get("/admin/models"));
    const rule = { public_id: "created-model", upstream_id: "org/model" };
    assert.equal((await client.post("/admin/models/preview", rule, { headers })).status, 200);
    const created = await client.post("/admin/models", { ...rule, revision: inventory.revision }, { headers });
    assert.equal(created.status, 201, created.body);
    const model = client.json<{ revision: number; model: { id: string } }>(created);
    assert.match(model.model.id, /^custom:/);
    const path = `/admin/models/${encodeURIComponent(model.model.id)}`;
    const preview = await client.post(`${path}/preview`, rule, { headers, rawPath: true });
    assert.equal(preview.status, 200, preview.body);
    const updated = await client.request("PUT", path, {
      headers, body: JSON.stringify({ ...rule, enabled: false, revision: model.revision }), rawPath: true,
    });
    assert.equal(updated.status, 200, updated.body);
    const revision = client.json<{ revision: number }>(updated).revision;
    const deleted = await client.request("DELETE", path, { headers, body: JSON.stringify({ revision }), rawPath: true });
    assert.equal(deleted.status, 200, deleted.body);
  });

  for (const id of ["org/model", "vendor:model", "@org/model"]) {
    it(`preserves encoded model ${id} read/update/preview/delete against real FastAPI`, async () => {
      requireBackend();
      const { client } = await login(gw, idp);
      const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
      const headers = { origin: gw.origin, "x-csrf-token": session.csrf_token, "content-type": "application/json" };
      const listed = await client.get("/admin/models");
      assert.equal(listed.status, 200, listed.body);
      const inventory = client.json<{ revision: number; models: Array<{ id: string; public_id: string; upstream_id: string }> }>(listed);
      const existing = inventory.models.find((model) => model.id === id);
      assert.ok(existing);
      const rule = { public_id: existing.public_id, upstream_id: existing.upstream_id };
      const path = `/admin/models/${encodeURIComponent(id)}`;
      const updated = await client.request("PUT", path, {
        headers, body: JSON.stringify({ ...rule, revision: inventory.revision, enabled: false }), rawPath: true,
      });
      assert.equal(updated.status, 200, updated.body);
      const changed = client.json<{ revision: number; model: { id: string; enabled: boolean } }>(updated);
      assert.equal(changed.model.id, id, "ASGI decodes exactly the intended ID");
      assert.equal(changed.model.enabled, false);
      const preview = await client.post(`${path}/preview`, { ...rule, enabled: true }, { headers, rawPath: true });
      assert.equal(preview.status, 200, preview.body);
      assert.ok(Array.isArray(client.json<{ candidates: unknown[] }>(preview).candidates));
      const deleted = await client.request("DELETE", path, {
        headers, body: JSON.stringify({ revision: changed.revision }), rawPath: true,
      });
      assert.equal(deleted.status, 200, deleted.body);
      const remaining = client.json<{ models: Array<{ id: string }> }>(await client.get("/admin/models"));
      assert.ok(!remaining.models.some((model) => model.id === id), "deleted rule disappears from the real inventory");
    });
  }
});
