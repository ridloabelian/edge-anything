import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export interface LegacyServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

function sendJson(res: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function matchRoute(
  actualMethod: string,
  actualPath: string,
  method: string,
  pattern: string,
): Record<string, string> | null {
  if (actualMethod !== method) return null;
  const pParts = pattern.split('/').filter(Boolean);
  const aParts = actualPath.split('/').filter(Boolean);
  if (pParts.length !== aParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i += 1) {
    const p = pParts[i]!;
    const a = aParts[i]!;
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

export async function startLegacyServer(port = 0): Promise<LegacyServerHandle> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaSql = readFileSync(path.join(here, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  const blobStorageDir = mkdtempSync(path.join(os.tmpdir(), 'edge-anything-legacy-blobs-'));
  mkdirSync(blobStorageDir, { recursive: true });
  const blobMeta = new Map<string, string>();
  const ttlCache = new Map<string, { value: string; expiresAt: number }>();

  function cacheGet(key: string): string | null {
    const entry = ttlCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      ttlCache.delete(key);
      return null;
    }
    return entry.value;
  }

  function cacheSet(key: string, value: string, ttlSeconds = 60): void {
    ttlCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  function invalidateNotesCache(): void {
    for (const k of ttlCache.keys()) {
      if (k.startsWith('notes:')) ttlCache.delete(k);
    }
  }

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of ttlCache.entries()) {
      if (now > v.expiresAt) ttlCache.delete(k);
    }
  }, 60_000);
  cleanupInterval.unref();

  const server = http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (matchRoute(method, pathname, 'GET', '/health')) {
      sendJson(res, 200, {
        ok: true,
        service: 'edge-notes-api',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (matchRoute(method, pathname, 'GET', '/api/notes')) {
      const q = (url.searchParams.get('q') ?? '').trim();
      const tag = (url.searchParams.get('tag') ?? '').trim();
      const cacheKey = `notes:${q}:${tag}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        sendJson(res, 200, JSON.parse(cached), { 'x-cache-hit': 'true' });
        return;
      }

      const rows = db.prepare('SELECT id, title, content, tags FROM notes ORDER BY id ASC').all() as Array<{
        id: number;
        title: string;
        content: string;
        tags: string;
      }>;

      const items = rows
        .map((r) => ({
          id: Number(r.id),
          title: r.title,
          content: r.content,
          tags: JSON.parse(r.tags) as string[],
        }))
        .filter((item) => {
          if (tag && !item.tags.includes(tag)) return false;
          if (q) {
            const needle = q.toLowerCase();
            if (!item.title.toLowerCase().includes(needle) && !item.content.toLowerCase().includes(needle)) {
              return false;
            }
          }
          return true;
        });

      const payload = { items, total: items.length };
      cacheSet(cacheKey, JSON.stringify(payload), 60);
      sendJson(res, 200, payload, { 'x-cache-hit': 'false' });
      return;
    }

    if (matchRoute(method, pathname, 'POST', '/api/notes')) {
      const raw = await readRequestBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON payload' });
        return;
      }
      if (typeof body.title !== 'string' || !body.title.trim()) {
        sendJson(res, 400, { error: 'Field "title" is required' });
        return;
      }
      const content = typeof body.content === 'string' ? body.content : '';
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];

      const info = db
        .prepare('INSERT INTO notes (title, content, tags) VALUES (?, ?, ?)')
        .run(body.title.trim(), content, JSON.stringify(tags));
      invalidateNotesCache();

      sendJson(res, 201, {
        id: Number(info.lastInsertRowid),
        title: body.title.trim(),
        content,
        tags,
      });
      return;
    }

    const noteGet = matchRoute(method, pathname, 'GET', '/api/notes/:id');
    if (noteGet) {
      const id = Number.parseInt(noteGet.id!, 10);
      if (!Number.isFinite(id)) {
        sendJson(res, 400, { error: 'Invalid note id' });
        return;
      }
      const row = db.prepare('SELECT id, title, content, tags FROM notes WHERE id = ?').get(id) as
        | { id: number; title: string; content: string; tags: string }
        | undefined;
      if (!row) {
        sendJson(res, 404, { error: 'Note not found' });
        return;
      }
      sendJson(res, 200, {
        id: Number(row.id),
        title: row.title,
        content: row.content,
        tags: JSON.parse(row.tags) as string[],
      });
      return;
    }

    const notePut = matchRoute(method, pathname, 'PUT', '/api/notes/:id');
    if (notePut) {
      const id = Number.parseInt(notePut.id!, 10);
      const raw = await readRequestBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON payload' });
        return;
      }
      const existing = db.prepare('SELECT id, title, content, tags FROM notes WHERE id = ?').get(id) as
        | { id: number; title: string; content: string; tags: string }
        | undefined;
      if (!existing) {
        sendJson(res, 404, { error: 'Note not found' });
        return;
      }
      const nextTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.title;
      const nextContent = typeof body.content === 'string' ? body.content : existing.content;
      const nextTags = Array.isArray(body.tags) ? body.tags.map(String) : (JSON.parse(existing.tags) as string[]);

      db.prepare('UPDATE notes SET title = ?, content = ?, tags = ? WHERE id = ?').run(
        nextTitle,
        nextContent,
        JSON.stringify(nextTags),
        id,
      );
      invalidateNotesCache();
      sendJson(res, 200, { id, title: nextTitle, content: nextContent, tags: nextTags });
      return;
    }

    const noteDel = matchRoute(method, pathname, 'DELETE', '/api/notes/:id');
    if (noteDel) {
      const id = Number.parseInt(noteDel.id!, 10);
      const info = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      if (Number(info.changes ?? 0) === 0) {
        sendJson(res, 404, { error: 'Note not found' });
        return;
      }
      invalidateNotesCache();
      sendJson(res, 200, { deleted: true, id });
      return;
    }

    if (matchRoute(method, pathname, 'POST', '/api/links')) {
      const raw = await readRequestBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON payload' });
        return;
      }
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl.trim() : '';
      if (!code || !targetUrl) {
        sendJson(res, 400, { error: 'Fields "code" and "targetUrl" are required' });
        return;
      }
      const exists = db.prepare('SELECT code FROM shortlinks WHERE code = ?').get(code);
      if (exists) {
        sendJson(res, 409, { error: 'Shortlink code already exists' });
        return;
      }
      db.prepare('INSERT INTO shortlinks (code, target_url, clicks) VALUES (?, ?, 0)').run(code, targetUrl);
      sendJson(res, 201, { code, targetUrl, clicks: 0 });
      return;
    }

    const linkRedirect = matchRoute(method, pathname, 'GET', '/s/:code');
    if (linkRedirect) {
      const code = linkRedirect.code!;
      const row = db.prepare('SELECT target_url FROM shortlinks WHERE code = ?').get(code) as
        | { target_url: string }
        | undefined;
      if (!row) {
        sendJson(res, 404, { error: 'Shortlink not found' });
        return;
      }
      db.prepare('UPDATE shortlinks SET clicks = clicks + 1 WHERE code = ?').run(code);
      res.writeHead(302, {
        location: row.target_url,
        ...CORS_HEADERS,
      });
      res.end();
      return;
    }

    const linkStats = matchRoute(method, pathname, 'GET', '/api/links/:code');
    if (linkStats) {
      const code = linkStats.code!;
      const row = db.prepare('SELECT code, target_url, clicks FROM shortlinks WHERE code = ?').get(code) as
        | { code: string; target_url: string; clicks: number }
        | undefined;
      if (!row) {
        sendJson(res, 404, { error: 'Shortlink not found' });
        return;
      }
      sendJson(res, 200, { code: row.code, targetUrl: row.target_url, clicks: Number(row.clicks) });
      return;
    }

    const blobPut = matchRoute(method, pathname, 'PUT', '/api/blobs/:key');
    if (blobPut) {
      const key = path.basename(blobPut.key!);
      const data = await readRequestBody(req);
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
      writeFileSync(path.join(blobStorageDir, key), data);
      blobMeta.set(key, contentType);
      sendJson(res, 201, { key, size: data.byteLength, contentType });
      return;
    }

    const blobGet = matchRoute(method, pathname, 'GET', '/api/blobs/:key');
    if (blobGet) {
      const key = path.basename(blobGet.key!);
      const target = path.join(blobStorageDir, key);
      try {
        const bytes = readFileSync(target);
        res.writeHead(200, {
          'content-type': blobMeta.get(key) ?? 'application/octet-stream',
          ...CORS_HEADERS,
        });
        res.end(bytes);
      } catch {
        sendJson(res, 404, { error: 'Blob not found' });
      }
      return;
    }

    const blobDel = matchRoute(method, pathname, 'DELETE', '/api/blobs/:key');
    if (blobDel) {
      const key = path.basename(blobDel.key!);
      if (!blobMeta.has(key)) {
        sendJson(res, 404, { error: 'Blob not found' });
        return;
      }
      rmSync(path.join(blobStorageDir, key), { force: true });
      blobMeta.delete(key);
      sendJson(res, 200, { deleted: true, key });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    async close() {
      clearInterval(cleanupInterval);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(blobStorageDir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const handle = await startLegacyServer(port);
  process.stdout.write(`Legacy server listening on ${handle.url}\n`);
}
