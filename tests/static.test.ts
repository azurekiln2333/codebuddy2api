import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * Static dashboard serving: path containment under uiStaticDir.
 *
 * A symlinked asset, directory index or SPA fallback must never serve a file
 * outside the configured UI root. The gateway canonicalizes both the root and
 * the candidate with realpath before comparing containment.
 */

describe("static dashboard path containment", () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;
  let root: string;
  let outside: string;

  before(async () => {
    idp = await startMockOAuth();
    upstream = await startUpstream();
    root = await mkdtemp(join(tmpdir(), "gw-ui-root-"));
    outside = await mkdtemp(join(tmpdir(), "gw-ui-outside-"));

    await writeFile(join(root, "index.html"), "<!doctype html><title>root dashboard</title>");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "app.js"), "console.log('ok');");

    // A secret OUTSIDE the UI root.
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE-ROOT");
    await writeFile(join(outside, "index.html"), "OUTSIDE-INDEX-MUST-NOT-SERVE");

    // Symlinked file inside the root pointing outside.
    try {
      await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    } catch {
      // Windows may require developer mode; tests below skip the symlink cases.
    }
    // Symlinked DIRECTORY inside the root pointing outside (fallback/index escape).
    try {
      await symlink(outside, join(root, "outdir"));
    } catch {
      // ignore
    }

    gw = await startGateway((publicOrigin, port) =>
      testConfig(idp, upstream, { publicOrigin, port, uiStaticDir: root }),
    );
  });
  after(async () => {
    await gw.close();
    await idp.close();
    await upstream.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function client(): HttpClient {
    return new HttpClient({ host: gw.host, port: gw.port });
  }

  it("serves the dashboard index and assets from the configured root", async () => {
    const c = client();
    const index = await c.get("/dashboard/");
    assert.equal(index.status, 200);
    assert.match(index.body, /root dashboard/);
    const asset = await c.get("/dashboard/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.body, /console.log/);
  });

  it("redirects / to /dashboard/", async () => {
    const res = await client().get("/");
    assert.equal(res.status, 302);
    assert.equal(res.location, "/dashboard/");
  });

  it("rejects encoded traversal and backslashes on the dashboard tree", async () => {
    const c = client();
    for (const target of [
      "/dashboard/..%2f..%2fsecret.txt",
      "/dashboard/%2e%2e/secret.txt",
      "/dashboard/..\\secret.txt",
      "/dashboard/%2e%2e%2fsecret.txt",
    ]) {
      const res = await c.request("GET", target, { rawPath: true });
      assert.ok(res.status >= 400, `${target} must be rejected, got ${res.status}`);
      assert.ok(!res.body.includes("TOP-SECRET"), `${target} must never read outside the root`);
    }
  });

  it("does not serve a symlinked file that escapes the UI root", async () => {
    const res = await client().get("/dashboard/leak.txt");
    assert.ok(res.status === 400 || res.status === 404, `symlink escape must not serve, got ${res.status}`);
    assert.ok(!res.body.includes("TOP-SECRET"), "symlinked file must never leak outside the root");
  });

  it("does not escape via a symlinked directory or its SPA fallback", async () => {
    const c = client();
    // The symlinked-out directory and its files must never be served from
    // outside the root.
    for (const target of ["/dashboard/outdir/", "/dashboard/outdir/secret.txt", "/dashboard/outdir/index.html"]) {
      const res = await c.get(target);
      assert.ok(res.status >= 400, `${target} must not serve outside content, got ${res.status}`);
      assert.ok(!res.body.includes("TOP-SECRET"), `${target} must never leak outside the root`);
    }
    // A missing path under a symlinked-out directory may fall back to the ROOT
    // SPA index (never the outside index), so assert no outside leak rather than
    // a specific status.
    const missing = await c.get("/dashboard/outdir/missing");
    assert.ok(!missing.body.includes("TOP-SECRET"), "SPA fallback must never serve outside content");
    assert.ok(!missing.body.includes("OUTSIDE-INDEX"), "SPA fallback must use the root index only");
  });

  it("falls back to index.html for an unknown SPA path inside the root", async () => {
    const res = await client().get("/dashboard/some/spa/route");
    assert.equal(res.status, 200);
    assert.match(res.body, /root dashboard/);
  });

  it("does not expose the dashboard tree for non-dashboard paths", async () => {
    const res = await client().get("/assets/app.js");
    assert.equal(res.status, 404);
  });
});
