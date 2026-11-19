import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { portProject } from '../src/porter/scaffold.ts';
import { lintEdgeProject } from '../src/verifier/linter.ts';

describe('Stage 3 & 4: Edge Porter & V8 Isolate Linter', () => {
  it('scaffolds a lint-clean Cloudflare Worker project from legacy source', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-port-src-'));
    const out = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-port-out-'));
    try {
      await writeFile(
        path.join(src, 'package.json'),
        JSON.stringify({
          name: 'notes-backend',
          dependencies: {
            express: '^4.19.0',
            'better-sqlite3': '^11.0.0',
            ioredis: '^5.4.0',
            '@aws-sdk/client-s3': '^3.500.0',
          },
        }),
      );
      await writeFile(
        path.join(src, 'index.ts'),
        `import express from 'express';
const app = express();
app.get('/api/items', (_req, res) => res.json({ items: [] }));
app.post('/api/items', (_req, res) => res.status(201).json({ id: 1 }));
`,
      );
      await writeFile(
        path.join(src, 'schema.sql'),
        'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      );

      const port = await portProject(src, { outDir: out, force: true });
      assert.ok(port.filesWritten.includes('wrangler.jsonc'));
      assert.ok(port.filesWritten.includes('src/index.ts'));
      assert.ok(port.filesWritten.includes('src/shims/d1.ts'));
      assert.ok(port.filesWritten.includes('src/shims/kv.ts'));
      assert.ok(port.filesWritten.includes('src/shims/r2.ts'));
      assert.ok(port.filesWritten.includes('migrations/0001_init.sql'));
      assert.equal(port.migrationsGenerated, 1);
      assert.equal(port.routesStubbed, 2);

      const wranglerRaw = await readFile(path.join(out, 'wrangler.jsonc'), 'utf8');
      assert.match(wranglerRaw, /"d1_databases"/);
      assert.match(wranglerRaw, /"kv_namespaces"/);
      assert.match(wranglerRaw, /"r2_buckets"/);

      const lint = await lintEdgeProject(out);
      assert.equal(lint.passed, true);
      assert.equal(lint.errorCount, 0);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it('flags global scope side effects, undeclared env bindings, and forbidden Node builtins', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-lint-bad-'));
    try {
      await writeFile(
        path.join(tmp, 'wrangler.jsonc'),
        JSON.stringify({
          name: 'bad-worker',
          main: 'src/index.ts',
          compatibility_date: '2026-11-01',
        }),
      );
      await portProject(tmp, { outDir: tmp, force: false });
      await writeFile(
        path.join(tmp, 'src', 'index.ts'),
        `import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
const bootTime = Date.now();
let requestCounter = 0;

export default {
  async fetch(request: Request, env: { SECRET_KV: { get(k: string): Promise<string | null> } }): Promise<Response> {
    requestCounter += 1;
    const val = await env.SECRET_KV.get('k');
    return Response.json({ bootTime, requestCounter, val, id: crypto.randomUUID(), exec: typeof execSync });
  },
};
`,
      );

      const lint = await lintEdgeProject(tmp);
      assert.equal(lint.passed, false);
      const rules = new Set(lint.findings.map((f) => f.rule));
      assert.ok(rules.has('ERR_FORBIDDEN_NODE_BUILTIN'));
      assert.ok(rules.has('ERR_MISSING_NODEJS_COMPAT'));
      assert.ok(rules.has('ERR_GLOBAL_SCOPE_SIDE_EFFECT'));
      assert.ok(rules.has('ERR_UNDECLARED_BINDING'));
      assert.ok(rules.has('WARN_MUTABLE_GLOBAL_STATE'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
