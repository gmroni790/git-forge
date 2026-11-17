// Small shared HTTP/base64 helpers. No cross-imports.

import type { ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * JSON.stringify(body) + '\n'; content-type 'application/json; charset=utf-8';
 * content-length set. (X-GitHub-Request-Id is set by app.ts on every response
 * before calling layer code; sendJson just adds/overrides the headers given.)
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Standard base64, no wrapping. */
export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

/** Strips whitespace first; throws on invalid base64. */
export function b64decode(s: string): Buffer {
  const cleaned = s.replace(/[\r\n\t ]+/g, '');
  if (cleaned.length === 0) return Buffer.alloc(0);
  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('invalid base64');
  }
  return Buffer.from(cleaned, 'base64');
}
