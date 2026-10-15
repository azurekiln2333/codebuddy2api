import { resolve } from "node:path";
import type { GatewayConfig } from "../../src/config.js";
import type { MockOAuthProvider } from "../fixtures/mock-oauth.js";
import type { UpstreamServer } from "../fixtures/upstream.js";

/**
 * Build a test GatewayConfig for real HTTP integration tests.
 *
 * Uses loopback HTTP so `allowInsecureLocalhost` is required; every origin is
 * synthetic (127.0.0.1). Tests must supply the mock IdP and upstream so the
 * configured issuer/upstream match the ephemeral ports.
 */
export function testConfig(
  idp: MockOAuthProvider,
  upstream: UpstreamServer,
  overrides?: Partial<GatewayConfig>,
): GatewayConfig {
  const base: GatewayConfig = {
    publicOrigin: "http://127.0.0.1:8788",
    oidcIssuer: idp.issuer,
    oidcClientId: idp.clientId,
    oidcClientSecret: idp.clientSecret,
    oidcRefresh: false,
    upstreamOrigin: upstream.origin,
    upstreamApiKey: upstream.apiKey,
    host: "127.0.0.1",
    port: 0,
    uiStaticDir: resolve("tests/fixtures/ui-dist"),
    allowInsecureLocalhost: true,
    sessionTtlMs: 3_600_000,
    sessionIdleMs: 600_000,
    transactionTtlMs: 60_000,
    maxSessions: 128,
    oauthTimeoutMs: 2_000,
    upstreamTimeoutMs: 2_000,
    streamTimeoutMs: 5_000,
    maxBodyBytes: 1_048_576,
    ...overrides,
  };
  return base;
}

/**
 * Build a test GatewayConfig against the REAL original FastAPI backend.
 * `upstreamOrigin` and `upstreamApiKey` come from the disposable launcher.
 */
export function realBackendConfig(
  idp: MockOAuthProvider,
  upstream: { origin: string; apiKey: string },
  overrides?: Partial<GatewayConfig>,
): GatewayConfig {
  return {
    publicOrigin: "http://127.0.0.1:8788",
    oidcIssuer: idp.issuer,
    oidcClientId: idp.clientId,
    oidcClientSecret: idp.clientSecret,
    oidcRefresh: false,
    upstreamOrigin: upstream.origin,
    upstreamApiKey: upstream.apiKey,
    host: "127.0.0.1",
    port: 0,
    uiStaticDir: resolve("tests/fixtures/ui-dist"),
    allowInsecureLocalhost: true,
    sessionTtlMs: 3_600_000,
    sessionIdleMs: 600_000,
    transactionTtlMs: 60_000,
    maxSessions: 128,
    oauthTimeoutMs: 2_000,
    upstreamTimeoutMs: 5_000,
    streamTimeoutMs: 5_000,
    maxBodyBytes: 1_048_576,
    ...overrides,
  };
}

/**
 * Rewrite the gateway's publicOrigin after the server binds an ephemeral port.
 * `createGateway` reads publicOrigin for same-origin/CSRF checks, so the test
 * must know the port before constructing the config. We achieve this by
 * binding a throwaway server first (see `withGatewayPort`).
 */
export async function reservePort(): Promise<number> {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
