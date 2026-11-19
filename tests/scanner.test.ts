import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { scanProject } from '../src/scanner/isolateAudit.ts';

describe('Stage 1: Architecture & Isolate Scanner', () => {
  it('detects Express routes, Postgres/Redis/S3/Cron bindings, and nodejs_compat', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-scan-express-'));
    try {
      await writeFile(
        path.join(tmp, 'package.json'),
        JSON.stringify({
          name: 'legacy-express',
          dependencies: {
            express: '^4.19.2',
            pg: '^8.12.0',
            ioredis: '^5.4.1',
            '@aws-sdk/client-s3': '^3.600.0',
            'node-cron': '^3.0.3',
          },
        }),
      );
      await mkdir(path.join(tmp, 'src'), { recursive: true });
      await writeFile(
        path.join(tmp, 'src', 'app.ts'),
        `import crypto from 'node:crypto';
import express from 'express';
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true, id: crypto.randomUUID() }));
app.post('/orders', (req, res) => res.status(201).json(req.body));
export default app;
`,
      );
      await writeFile(
        path.join(tmp, 'schema.sql'),
        'CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, total INTEGER NOT NULL);',
      );

      const report = await scanProject(tmp);
      assert.equal(report.language, 'TypeScript');
      assert.equal(report.framework, 'express');
      assert.equal(report.requiresNodejsCompat, true);
      assert.equal(report.requiresContainers, false);
      assert.equal(report.recommendedStrategy, 'workers-nodejs-compat');
      assert.ok(report.routes.some((r) => r.method === 'GET' && r.path === '/health'));
      assert.ok(report.routes.some((r) => r.method === 'POST' && r.path === '/orders'));
      assert.equal(report.sqlSchemas.length, 1);

      const kinds = new Set(report.bindings.map((b) => b.kind));
      assert.ok(kinds.has('hyperdrive'));
      assert.ok(kinds.has('kv'));
      assert.ok(kinds.has('r2'));
      assert.ok(kinds.has('cron'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('flags child_process and Dockerfile as hybrid container strategy', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-scan-docker-'));
    try {
      await writeFile(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'video-worker', dependencies: { fastify: '^4.0.0', sharp: '^0.33.0' } }),
      );
      await writeFile(path.join(tmp, 'Dockerfile'), 'FROM node:22-alpine\nRUN apk add ffmpeg\n');
      await writeFile(
        path.join(tmp, 'server.js'),
        `import { execSync } from 'node:child_process';
import Fastify from 'fastify';
const app = Fastify();
app.post('/transcode', async () => execSync('ffmpeg -version').toString());
`,
      );

      const report = await scanProject(tmp);
      assert.equal(report.framework, 'fastify');
      assert.equal(report.requiresContainers, true);
      assert.equal(report.recommendedStrategy, 'workers-hybrid-containers');
      assert.ok(report.bindings.some((b) => b.kind === 'containers'));
      assert.ok(report.isolateIssues.some((i) => i.code === 'BLOCKER_FORBIDDEN_BUILTIN'));
      assert.ok(report.isolateIssues.some((i) => i.code === 'BLOCKER_NATIVE_ADDON'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('detects Python FastAPI routes and SQLite -> D1 mapping', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-scan-py-'));
    try {
      await writeFile(path.join(tmp, 'requirements.txt'), 'fastapi==0.115.0\naiosqlite==0.20.0\n');
      await writeFile(
        path.join(tmp, 'main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/ping")
async def ping():
    return {"pong": True}

@app.post("/items")
async def create_item():
    return {"created": True}
`,
      );

      const report = await scanProject(tmp);
      assert.equal(report.language, 'Python');
      assert.equal(report.framework, 'fastapi');
      assert.ok(report.routes.some((r) => r.method === 'GET' && r.path === '/ping'));
      assert.ok(report.routes.some((r) => r.method === 'POST' && r.path === '/items'));
      assert.ok(report.bindings.some((b) => b.kind === 'd1'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
