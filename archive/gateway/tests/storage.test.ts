import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";

describe("storage routes preserve absent upstream handlers", () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;

  before(async () => {
    idp = await startMockOAuth();
    // This existing fixture has no storage handlers; its 404 is intentional.
    upstream = await startUpstream();
    gw = await startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port }));
  });

  after(async () => {
    await gw?.close();
    await idp?.close();
    await upstream?.close();
  });

  it("forwards both exact storage targets and preserves the upstream 404 body", async () => {
    const { client } = await login(gw, idp);
    const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const headers = { origin: gw.origin, "x-csrf-token": session.csrf_token };
    assert.equal((await client.get("/admin/dashboard")).status, 200, "establish the bridge before measuring storage requests");

    for (const [method, path] of [["GET", "/admin/storage"], ["POST", "/admin/storage/archive"]] as const) {
      const beforeRequests = upstream.requests.length;
      const beforeCount = upstream.counts[path] ?? 0;
      const res = method === "GET"
        ? await client.get(path, { rawPath: true })
        : await client.post(path, { days: 30 }, { headers, rawPath: true });

      assert.equal(res.status, 404, `${method} ${path}: ${res.body}`);
      assert.equal(res.body, JSON.stringify({ error: "not_found" }));
      assert.deepEqual(upstream.requests.slice(beforeRequests), [path]);
      assert.equal(upstream.counts[path], beforeCount + 1);
      assert.equal(res.setCookie.length, 0);
    }
  });
});
