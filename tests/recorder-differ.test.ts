import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { recordTraffic } from '../src/recorder/recorder.ts';
import { diffAgainstTarget } from '../src/verifier/differ.ts';

describe('Stage 2 & 5: Traffic Recorder, Edge Simulator & Parity Differ', () => {
  it('records HTTP traffic and detects both 100% parity and deliberate regressions', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-diff-'));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/go') {
        res.writeHead(302, { location: 'https://cloudflare.com' });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const corpus = await recordTraffic({
        originUrl: `http://127.0.0.1:${port}`,
        cases: [
          { id: 'c1', label: 'health', method: 'GET', pathWithQuery: '/health', headers: {} },
          { id: 'c2', label: 'redirect', method: 'GET', pathWithQuery: '/go', headers: {} },
          { id: 'c3', label: 'missing', method: 'GET', pathWithQuery: '/nope', headers: {} },
        ],
      });

      assert.equal(corpus.cases.length, 3);
      assert.equal(corpus.cases[1]!.response.status, 302);
      assert.equal(corpus.cases[1]!.response.headers.location, 'https://cloudflare.com');

      const goodDir = path.join(tmp, 'good-worker');
      await mkdir(path.join(goodDir, 'src'), { recursive: true });
      await writeFile(
        path.join(goodDir, 'wrangler.jsonc'),
        JSON.stringify({ name: 'good', main: 'src/index.ts', compatibility_date: '2026-11-01' }),
      );
      await writeFile(
        path.join(goodDir, 'src', 'index.ts'),
        `export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, timestamp: '2099-01-01T00:00:00.000Z' });
    }
    if (url.pathname === '/go') {
      return new Response(null, { status: 302, headers: { location: 'https://cloudflare.com' } });
    }
    return Response.json({ error: 'Not Found' }, { status: 404 });
  },
};
`,
      );

      const goodDiff = await diffAgainstTarget({
        corpus,
        workerEntry: path.join(goodDir, 'src', 'index.ts'),
      });
      assert.equal(goodDiff.matched, 3);
      assert.equal(goodDiff.failed, 0);
      assert.equal(goodDiff.passRate, 100);

      // Now inject status + JSON field + Location regressions
      const badDir = path.join(tmp, 'bad-worker');
      await mkdir(path.join(badDir, 'src'), { recursive: true });
      await writeFile(
        path.join(badDir, 'wrangler.jsonc'),
        JSON.stringify({ name: 'bad', main: 'src/index.ts', compatibility_date: '2026-11-01' }),
      );
      await writeFile(
        path.join(badDir, 'src', 'index.ts'),
        `export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: false, timestamp: 12345 });
    }
    if (url.pathname === '/go') {
      return new Response(null, { status: 302, headers: { location: 'https://wrong.example' } });
    }
    return Response.json({ error: 'Different' }, { status: 500 });
  },
};
`,
      );

      const badDiff = await diffAgainstTarget({
        corpus,
        workerEntry: path.join(badDir, 'src', 'index.ts'),
      });
      assert.equal(badDiff.matched, 0);
      assert.equal(badDiff.failed, 3);
      assert.ok(badDiff.results[0]!.mismatches.some((m) => m.includes('$.ok')));
      assert.ok(badDiff.results[0]!.mismatches.some((m) => m.includes('Masked JSON key type mismatch')));
      assert.ok(badDiff.results[1]!.mismatches.some((m) => m.includes('Location header mismatch')));
      assert.ok(badDiff.results[2]!.mismatches.some((m) => m.includes('Status mismatch')));
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
