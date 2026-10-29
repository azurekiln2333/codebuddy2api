import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpClient } from "./http-client.js";
import { type MockOAuthProvider } from "../fixtures/mock-oauth.js";

/**
 * Helpers for driving the gateway over real HTTP.
 *
 * `createGateway` is imported lazily as a type-only reference so this helper
 * file can exist before the server module is written; the tests that use it
 * fail at module resolution (an explicit, actionable error) rather than
 * silently skipping.
 */

export interface RunningGateway {
  server: Server;
  origin: string;
  host: string;
  port: number;
  client: HttpClient;
  close(): Promise<void>;
}

export async function listen(server: Server, port = 0): Promise<RunningGateway> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const host = "127.0.0.1";
  const origin = `http://${host}:${address.port}`;
  return {
    server,
    origin,
    host,
    port: address.port,
    client: new HttpClient({ host, port: address.port }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Start a gateway on a stable port so `config.publicOrigin` matches the actual
 * bound origin. `reservePort()` picks a free port, the config is built with
 * that exact origin, then the server binds to the SAME port. This keeps
 * same-origin / CSRF checks meaningful.
 */
export async function startGateway(
  makeConfig: (publicOrigin: string, port: number) => import("../../src/config.js").GatewayConfig,
): Promise<RunningGateway> {
  const { createGateway } = await import("../../src/server.js");
  const { reservePort } = await import("./config.js");
  const port = await reservePort();
  const publicOrigin = `http://127.0.0.1:${port}`;
  const config = makeConfig(publicOrigin, port);
  const server = createGateway(config) as Server;
  return listen(server, port);
}

/**
 * Drive a complete authorization-code + PKCE login through the gateway.
 *
 * Flow:
 *  1. GET /sso/login?return_to=...  -> 302 to the mock IdP /authorize
 *  2. Follow the IdP authorize (the mock responds 302 back to the gateway
 *     callback with `code` and `state`, preserving the PKCE challenge).
 *  3. GET /sso/callback?code=&state= -> session cookie + redirect.
 *
 * Returns the same HttpClient now holding the gateway session cookie.
 */
export async function login(
  gw: RunningGateway,
  idp: MockOAuthProvider,
  options?: { returnTo?: string; client?: HttpClient },
): Promise<{ client: HttpClient; callback: Awaited<ReturnType<HttpClient["get"]>> }> {
  const client = options?.client ?? gw.client;
  return loginInFlight(client, () => performLogin(gw, idp, client, options?.returnTo ?? "/dashboard/"));
}

/**
 * Serialize concurrent logins on the same HttpClient.
 *
 * The gateway (correctly, for a real browser) follows the fixed session-cookie
 * login flow: each successful login creates a NEW session id and overwrites the
 * cookie. Two concurrent logins on one jar would therefore leave one of the
 * returned callbacks holding a session that is no longer in the jar, which is a
 * client-side race, not a gateway bug. Callers that want parallelism should use
 * a distinct HttpClient per login.
 */
const loginByClient = new WeakMap<HttpClient, Promise<void>>();

async function loginInFlight<T>(client: HttpClient, run: () => Promise<T>): Promise<T> {
  const previous = loginByClient.get(client) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  loginByClient.set(
    client,
    previous.then(() => current),
  );
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

async function performLogin(
  gw: RunningGateway,
  idp: MockOAuthProvider,
  client: HttpClient,
  returnTo: string,
): Promise<{ client: HttpClient; callback: Awaited<ReturnType<HttpClient["get"]>> }> {
  const loginResponse = await client.get(
    `/sso/login?return_to=${encodeURIComponent(returnTo)}`,
  );
  if (loginResponse.status < 300 || loginResponse.status >= 400 || !loginResponse.location) {
    throw new Error(`expected /sso/login redirect, got ${loginResponse.status} ${loginResponse.body.slice(0, 200)}`);
  }

  // The gateway's authorize URL already contains code_challenge; follow it to
  // the IdP, which redirects straight back to our callback.
  const authorizeUrl = new URL(loginResponse.location);
  // Guard: never let the test silently talk to a real domain.
  if (authorizeUrl.hostname !== "127.0.0.1" && authorizeUrl.hostname !== "localhost") {
    throw new Error(`refusing to follow non-local authorize URL: ${authorizeUrl.origin}`);
  }

  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const callbackLocation = authorizeResponse.headers.get("location");
  if (!callbackLocation) {
    throw new Error(`mock IdP did not redirect (${authorizeResponse.status})`);
  }
  const callbackUrl = new URL(callbackLocation);
  const callback = await client.get(`${callbackUrl.pathname}${callbackUrl.search}`);

  return { client, callback };
}

/**
 * Perform a redirecting GET on a client and return the final response,
 * following at most `maxHops` same-origin redirects.
 */
export async function follow(
  client: HttpClient,
  path: string,
  maxHops = 5,
): Promise<Awaited<ReturnType<HttpClient["get"]>>> {
  let current = path;
  let response = await client.get(current);
  let hops = 0;
  while (response.status >= 300 && response.status < 400 && response.location && hops < maxHops) {
    const next = new URL(response.location, "http://placeholder.invalid");
    current = `${next.pathname}${next.search}`;
    response = await client.get(current);
    hops += 1;
  }
  return response;
}
