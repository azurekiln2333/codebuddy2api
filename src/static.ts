import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { GatewayConfig } from "./config.js";

/**
 * Static file serving for the dashboard tree only.
 *
 * The UI build lives outside the gateway source in a configurable directory.
 * Every resolved path is canonicalized and must remain inside uiStaticDir, so
 * symlinks, `..` segments or encoded traversal cannot escape the UI root.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Return true when `target` is inside `root` (both absolute, already canonical). */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Serve a dashboard asset. Returns true when the request was handled (including
 * 404/405 responses owned by this module), false when the path is not a
 * dashboard route and the caller should continue routing.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: GatewayConfig,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    // Dashboard is read-only; other methods are not our route.
    return false;
  }

  const pathname = url.pathname;
  // Only dashboard tree is served here. `/` is redirected by the server layer.
  if (pathname !== "/dashboard" && !pathname.startsWith("/dashboard/")) {
    return false;
  }

  if (!config.uiStaticDir) {
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("UI build directory is not configured");
    return true;
  }

  const root = resolve(config.uiStaticDir);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("UI build directory is unavailable");
    return true;
  }

  let suffix = pathname.slice("/dashboard".length);
  if (suffix === "" || suffix === "/") suffix = "/index.html";

  // Decode once; reject malformed encodings and backslashes/control chars.
  let decoded: string;
  try {
    decoded = decodeURIComponent(suffix);
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }
  // Reject anything suspicious before touching the filesystem.
  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    /(^|\/)\.\.(\/|$)/.test(decoded)
  ) {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }

  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = resolve(rootReal, normalize(relativePath));

  // Canonicalize the candidate too, so symlinked files cannot escape the root.
  let fileReal: string;
  try {
    fileReal = await realpath(candidate);
  } catch {
    await serveNotFound(req, res, rootReal);
    return true;
  }
  if (!isWithin(rootReal, fileReal)) {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }

  let info;
  try {
    info = await stat(fileReal);
  } catch {
    await serveNotFound(req, res, rootReal);
    return true;
  }
  if (info.isDirectory()) {
    // Directory index: canonicalize the index file too, so a symlinked
    // index.html pointing outside the UI root cannot be served.
    const index = await containedIndex(rootReal, fileReal);
    if (index) return sendFile(req, res, index.path, index.size, index.mtime);
    res.statusCode = 403;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }
  if (!info.isFile()) {
    res.statusCode = 403;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  return sendFile(req, res, fileReal, info.size, info.mtime.toUTCString());
}

/**
 * Resolve `<dir>/index.html` and require the canonical path to stay inside the
 * UI root. Returns null when the index is missing, not a regular file, or
 * escapes root through a symlink.
 */
async function containedIndex(
  rootReal: string,
  dir: string,
): Promise<{ path: string; size: number; mtime: string } | null> {
  const candidate = join(dir, "index.html");
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return null;
  }
  if (!isWithin(rootReal, real)) return null;
  try {
    const info = await stat(real);
    if (!info.isFile()) return null;
    return { path: real, size: info.size, mtime: info.mtime.toUTCString() };
  } catch {
    return null;
  }
}

/** SPA fallback: serve index.html for unknown non-asset dashboard paths, else 404. */
async function serveNotFound(req: IncomingMessage, res: ServerResponse, rootReal: string): Promise<void> {
  // The fallback index must also be realpath-contained: a symlinked index.html
  // escaping the UI root must not be served (fix 5).
  const index = await containedIndex(rootReal, rootReal);
  if (index) {
    await sendFile(req, res, index.path, index.size, index.mtime);
    return;
  }
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number,
  lastModified: string,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    res.statusCode = 200;
    res.setHeader("content-type", contentType(filePath));
    res.setHeader("content-length", String(size));
    res.setHeader("last-modified", lastModified);
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "HEAD") {
      res.end();
      resolvePromise(true);
      return;
    }
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      } else {
        res.destroy();
      }
      resolvePromise(true);
    });
    stream.on("end", () => resolvePromise(true));
    stream.pipe(res);
  });
}
