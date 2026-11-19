import type { Env } from './env.ts';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(payload, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders,
    },
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

async function invalidateNotesCache(kv: Env['CACHE']): Promise<void> {
  const list = await kv.list({ prefix: 'notes:' });
  for (const k of list.keys) {
    await kv.delete(k.name);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (matchRoute(method, pathname, 'GET', '/health')) {
      return jsonResponse({
        ok: true,
        service: 'edge-notes-api',
        timestamp: new Date().toISOString(),
      });
    }

    if (matchRoute(method, pathname, 'GET', '/api/notes')) {
      const q = (url.searchParams.get('q') ?? '').trim();
      const tag = (url.searchParams.get('tag') ?? '').trim();
      const cacheKey = `notes:${q}:${tag}`;
      const cached = await env.CACHE.get(cacheKey, 'text');
      if (typeof cached === 'string') {
        return jsonResponse(JSON.parse(cached), 200, { 'x-cache-hit': 'true' });
      }

      const { results } = await env.DB.prepare(
        'SELECT id, title, content, tags FROM notes ORDER BY id ASC',
      ).all<{ id: number; title: string; content: string; tags: string }>();

      const items = results
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
      await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 });
      return jsonResponse(payload, 200, { 'x-cache-hit': 'false' });
    }

    if (matchRoute(method, pathname, 'POST', '/api/notes')) {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Invalid JSON payload' }, 400);
      }
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return jsonResponse({ error: 'Field "title" is required' }, 400);
      }
      const content = typeof body.content === 'string' ? body.content : '';
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];

      const res = await env.DB.prepare('INSERT INTO notes (title, content, tags) VALUES (?, ?, ?)')
        .bind(body.title.trim(), content, JSON.stringify(tags))
        .run();
      await invalidateNotesCache(env.CACHE);
      await env.JOBS.send({ event: 'note.created', id: res.meta.last_row_id });

      return jsonResponse(
        {
          id: Number(res.meta.last_row_id),
          title: body.title.trim(),
          content,
          tags,
        },
        201,
      );
    }

    const noteGet = matchRoute(method, pathname, 'GET', '/api/notes/:id');
    if (noteGet) {
      const id = Number.parseInt(noteGet.id!, 10);
      if (!Number.isFinite(id)) {
        return jsonResponse({ error: 'Invalid note id' }, 400);
      }
      const row = await env.DB.prepare('SELECT id, title, content, tags FROM notes WHERE id = ?')
        .bind(id)
        .first<{ id: number; title: string; content: string; tags: string }>();
      if (!row) {
        return jsonResponse({ error: 'Note not found' }, 404);
      }
      return jsonResponse({
        id: Number(row.id),
        title: row.title,
        content: row.content,
        tags: JSON.parse(row.tags) as string[],
      });
    }

    const notePut = matchRoute(method, pathname, 'PUT', '/api/notes/:id');
    if (notePut) {
      const id = Number.parseInt(notePut.id!, 10);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Invalid JSON payload' }, 400);
      }
      const existing = await env.DB.prepare('SELECT id, title, content, tags FROM notes WHERE id = ?')
        .bind(id)
        .first<{ id: number; title: string; content: string; tags: string }>();
      if (!existing) {
        return jsonResponse({ error: 'Note not found' }, 404);
      }
      const nextTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.title;
      const nextContent = typeof body.content === 'string' ? body.content : existing.content;
      const nextTags = Array.isArray(body.tags) ? body.tags.map(String) : (JSON.parse(existing.tags) as string[]);

      await env.DB.prepare('UPDATE notes SET title = ?, content = ?, tags = ? WHERE id = ?')
        .bind(nextTitle, nextContent, JSON.stringify(nextTags), id)
        .run();
      await invalidateNotesCache(env.CACHE);
      return jsonResponse({ id, title: nextTitle, content: nextContent, tags: nextTags });
    }

    const noteDel = matchRoute(method, pathname, 'DELETE', '/api/notes/:id');
    if (noteDel) {
      const id = Number.parseInt(noteDel.id!, 10);
      const info = await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
      if (Number(info.meta.changes ?? 0) === 0) {
        return jsonResponse({ error: 'Note not found' }, 404);
      }
      await invalidateNotesCache(env.CACHE);
      return jsonResponse({ deleted: true, id });
    }

    if (matchRoute(method, pathname, 'POST', '/api/links')) {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Invalid JSON payload' }, 400);
      }
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl.trim() : '';
      if (!code || !targetUrl) {
        return jsonResponse({ error: 'Fields "code" and "targetUrl" are required' }, 400);
      }
      const exists = await env.DB.prepare('SELECT code FROM shortlinks WHERE code = ?').bind(code).first();
      if (exists) {
        return jsonResponse({ error: 'Shortlink code already exists' }, 409);
      }
      await env.DB.prepare('INSERT INTO shortlinks (code, target_url, clicks) VALUES (?, ?, 0)')
        .bind(code, targetUrl)
        .run();
      return jsonResponse({ code, targetUrl, clicks: 0 }, 201);
    }

    const linkRedirect = matchRoute(method, pathname, 'GET', '/s/:code');
    if (linkRedirect) {
      const code = linkRedirect.code!;
      const row = await env.DB.prepare('SELECT target_url FROM shortlinks WHERE code = ?')
        .bind(code)
        .first<{ target_url: string }>();
      if (!row) {
        return jsonResponse({ error: 'Shortlink not found' }, 404);
      }
      await env.DB.prepare('UPDATE shortlinks SET clicks = clicks + 1 WHERE code = ?').bind(code).run();
      return new Response(null, {
        status: 302,
        headers: {
          location: row.target_url,
          ...CORS_HEADERS,
        },
      });
    }

    const linkStats = matchRoute(method, pathname, 'GET', '/api/links/:code');
    if (linkStats) {
      const code = linkStats.code!;
      const row = await env.DB.prepare('SELECT code, target_url, clicks FROM shortlinks WHERE code = ?')
        .bind(code)
        .first<{ code: string; target_url: string; clicks: number }>();
      if (!row) {
        return jsonResponse({ error: 'Shortlink not found' }, 404);
      }
      return jsonResponse({ code: row.code, targetUrl: row.target_url, clicks: Number(row.clicks) });
    }

    const blobPut = matchRoute(method, pathname, 'PUT', '/api/blobs/:key');
    if (blobPut) {
      const key = blobPut.key!.split('/').pop()!;
      const bytes = await request.arrayBuffer();
      const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      return jsonResponse({ key, size: bytes.byteLength, contentType }, 201);
    }

    const blobGet = matchRoute(method, pathname, 'GET', '/api/blobs/:key');
    if (blobGet) {
      const key = blobGet.key!.split('/').pop()!;
      const obj = await env.BUCKET.get(key);
      if (!obj) {
        return jsonResponse({ error: 'Blob not found' }, 404);
      }
      return new Response(await obj.arrayBuffer(), {
        status: 200,
        headers: {
          'content-type': obj.httpMetadata.contentType ?? 'application/octet-stream',
          ...CORS_HEADERS,
        },
      });
    }

    const blobDel = matchRoute(method, pathname, 'DELETE', '/api/blobs/:key');
    if (blobDel) {
      const key = blobDel.key!.split('/').pop()!;
      const head = await env.BUCKET.head(key);
      if (!head) {
        return jsonResponse({ error: 'Blob not found' }, 404);
      }
      await env.BUCKET.delete(key);
      return jsonResponse({ deleted: true, key });
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },

  async scheduled(_controller: { cron: string }, env: Env): Promise<void> {
    await invalidateNotesCache(env.CACHE);
  },
};
