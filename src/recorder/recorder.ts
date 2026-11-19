import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { scanProject } from '../scanner/isolateAudit.ts';
import { buildProbeSuite, loadScenarioSpec } from './prober.ts';
import type { RecordedCase, RecordedRequest, ReplayCorpus } from '../types.ts';

export interface RecordTrafficOptions {
  originUrl: string;
  cmd?: string;
  cwd?: string;
  sourceDir?: string;
  specPath?: string;
  outPath?: string;
  cases?: RecordedRequest[];
  timeoutMs?: number;
}

function isBinaryContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  if (!lower) return false;
  if (
    lower.startsWith('text/') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    lower.includes('javascript') ||
    lower.includes('form-urlencoded')
  ) {
    return false;
  }
  return (
    lower.startsWith('application/octet-stream') ||
    lower.startsWith('image/') ||
    lower.startsWith('audio/') ||
    lower.startsWith('video/') ||
    lower.startsWith('application/pdf') ||
    lower.startsWith('application/zip')
  );
}

async function waitForServerReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual' });
      await res.arrayBuffer();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(
    `Timed out waiting for origin server at ${url} after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function recordTraffic(options: RecordTrafficOptions): Promise<ReplayCorpus> {
  const originBase = options.originUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 12_000;

  let requests: RecordedRequest[];
  if (options.cases && options.cases.length > 0) {
    requests = options.cases;
  } else if (options.specPath) {
    requests = await loadScenarioSpec(options.specPath);
  } else if (options.sourceDir) {
    const scan = await scanProject(options.sourceDir);
    requests = buildProbeSuite(scan.routes);
  } else {
    requests = buildProbeSuite([]);
  }

  let child: ReturnType<typeof spawn> | null = null;
  if (options.cmd) {
    child = spawn(options.cmd, {
      shell: true,
      cwd: options.cwd ?? options.sourceDir ?? process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    await waitForServerReady(originBase, timeoutMs);
  }

  const cases: RecordedCase[] = [];
  try {
    for (const req of requests) {
      const targetUrl = `${originBase}${req.pathWithQuery.startsWith('/') ? '' : '/'}${req.pathWithQuery}`;
      const started = performance.now();
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'manual',
      });
      const rawBytes = new Uint8Array(await response.arrayBuffer());
      const durationMs = Number((performance.now() - started).toFixed(3));

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      const contentType = headers['content-type'] ?? '';
      const isBase64 = isBinaryContentType(contentType);
      const body = isBase64
        ? Buffer.from(rawBytes).toString('base64')
        : Buffer.from(rawBytes).toString('utf8');

      cases.push({
        request: req,
        response: {
          status: response.status,
          headers,
          body,
          ...(isBase64 ? { isBase64: true } : {}),
          durationMs,
        },
      });
    }
  } finally {
    if (child && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // Process already exited
        }
      }
    }
  }

  const sha256 = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
  const corpus: ReplayCorpus = {
    version: '1.0',
    createdAt: new Date().toISOString(),
    originUrl: originBase,
    sha256,
    cases,
  };

  if (options.outPath) {
    const absOut = path.resolve(options.outPath);
    await mkdir(path.dirname(absOut), { recursive: true });
    await writeFile(absOut, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  }

  return corpus;
}
