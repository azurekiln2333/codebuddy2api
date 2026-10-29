import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayConfig } from './config.js';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'HttpError';
  }
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > maxBytes) throw new HttpError(413, 'body_too_large');
    chunks.push(data);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json_object');
  return body as Record<string, unknown>;
}

export function requireSameOrigin(req: IncomingMessage, config: GatewayConfig): void {
  const fetchSite = req.headers['sec-fetch-site'];
  if (req.headers.origin !== config.publicOrigin || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
    throw new HttpError(403, 'origin_denied');
  }
}

export function requireCsrf(req: IncomingMessage, session: { csrfToken: string }, config: GatewayConfig): void {
  requireSameOrigin(req, config);
  const supplied = req.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !supplied || !session.csrfToken) throw new HttpError(403, 'csrf_denied');
  const expectedBytes = Buffer.from(session.csrfToken);
  const suppliedBytes = Buffer.from(supplied);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new HttpError(403, 'csrf_denied');
  }
}
