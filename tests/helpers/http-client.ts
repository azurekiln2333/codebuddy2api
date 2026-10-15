import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

/**
 * Minimal raw HTTP client used by integration tests.
 *
 * It deliberately exposes `rawPath` so a test can send a literal request
 * target (for example `/v1/../admin/session`) exactly as `curl --path-as-is`
 * would, without Node's URL parser or fetch normalising the dot segments
 * before the request leaves the client. That is the only way to prove the
 * gateway rejects encoded traversal before classification.
 */

export interface HttpClientOptions {
  host: string;
  port: number;
  /** Cookie jar keyed by name. */
  cookies?: Map<string, string>;
  /** Disable automatic redirect following (we assert Location ourselves). */
  followRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** Multiple Set-Cookie values in order. */
  setCookie: string[];
  body: string;
  /** Location header if present. */
  location: string | null;
}

export class HttpClient {
  readonly cookies: Map<string, string>;
  private readonly origin: string;
  private readonly followRedirects: boolean;

  constructor(options: HttpClientOptions) {
    this.origin = `http://${options.host}:${options.port}`;
    this.cookies = options.cookies ?? new Map();
    this.followRedirects = options.followRedirects ?? false;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Parse Set-Cookie headers into the jar, honoring Max-Age=0 deletion. */
  private storeCookies(setCookie: string[]): void {
    for (const raw of setCookie) {
      const pair = raw.split(";", 1)[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      const lower = raw.toLowerCase();
      if (value === "" || /max-age=0(?!\d)/.test(lower)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  async request(
    method: string,
    path: string,
    options?: {
      headers?: Record<string, string>;
      body?: string | Buffer;
      /** Send `path` literally without normalization (raw request target). */
      rawPath?: boolean;
    },
  ): Promise<HttpResponse> {
    const cookieHeader = this.cookieHeader();
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (cookieHeader && !("cookie" in headers)) headers.cookie = cookieHeader;
    if (options?.body !== undefined && !("content-length" in headers)) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }

    const rawPath = options?.rawPath ?? false;
    const result = await new Promise<HttpResponse>((resolve, reject) => {
      const onResponse = (res: import("node:http").IncomingMessage): void => {
        void this.collect(res).then(resolve, reject);
      };
      const req = rawPath
        ? // Bypass URL parsing entirely by passing the raw path as request target.
          (() => {
            const parsed = new URL(this.origin);
            return httpRequest(
              { host: parsed.hostname, port: parsed.port, method, path, headers },
              onResponse,
            );
          })()
        : httpRequest(new URL(path, this.origin), { method, headers }, onResponse);
      req.on("error", reject);
      if (options?.body !== undefined) req.end(options.body);
      else req.end();
    });

    this.storeCookies(result.setCookie);
    if (this.followRedirects && result.location && result.status >= 300 && result.status < 400) {
      return this.request("GET", result.location, { headers: options?.headers });
    }
    return result;
  }

  private collect(res: import("node:http").IncomingMessage): Promise<HttpResponse> {
    const chunks: Buffer[] = [];
    return new Promise<HttpResponse>((resolve) => {
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const setCookie = res.headers["set-cookie"];
        const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          setCookie: list,
          body: Buffer.concat(chunks).toString("utf8"),
          location: (res.headers.location as string) ?? null,
        });
      });
    });
  }

  get(path: string, options?: { headers?: Record<string, string>; rawPath?: boolean }): Promise<HttpResponse> {
    return this.request("GET", path, options);
  }

  post(
    path: string,
    body?: string | Record<string, unknown>,
    options?: { headers?: Record<string, string>; rawPath?: boolean },
  ): Promise<HttpResponse> {
    const payload = typeof body === "string" || body === undefined ? body : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...(options?.headers ?? {}) };
    return this.request("POST", path, { headers, body: payload, rawPath: options?.rawPath });
  }

  delete(
    path: string,
    options?: { headers?: Record<string, string>; body?: string | Record<string, unknown> },
  ): Promise<HttpResponse> {
    const payload =
      typeof options?.body === "string" || options?.body === undefined
        ? options?.body
        : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(options?.headers ?? {}),
    };
    return this.request("DELETE", path, { headers, body: payload });
  }

  patch(
    path: string,
    body?: string | Record<string, unknown>,
    options?: { headers?: Record<string, string> },
  ): Promise<HttpResponse> {
    const payload = typeof body === "string" || body === undefined ? body : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...(options?.headers ?? {}) };
    return this.request("PATCH", path, { headers, body: payload });
  }

  /** JSON-parse the response body, surfacing a helpful error when it is not JSON. */
  json<T = unknown>(response: HttpResponse): T {
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new Error(`expected JSON body, got (${response.status}): ${response.body.slice(0, 200)}`);
    }
  }
}
