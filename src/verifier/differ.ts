import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWorkerSimulator } from './simulator.ts';
import type { CaseDiff, DiffReport, ReplayCorpus } from '../types.ts';

export interface DiffOptions {
  corpus?: ReplayCorpus;
  corpusPath?: string;
  targetUrl?: string;
  workerEntry?: string;
  migrationsDir?: string;
  ignoreFields?: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx]!.toFixed(3));
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed !== 'null' && trimmed !== 'true' && trimmed !== 'false' && !/^"-?\d|^-?\d/.test(trimmed)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function diffJsonValues(
  expected: unknown,
  actual: unknown,
  jsonPath: string,
  ignoreFields: Set<string>,
  mismatches: string[],
): void {
  if (expected === actual) return;

  if (expected === null || actual === null || typeof expected !== typeof actual) {
    mismatches.push(`JSON mismatch at ${jsonPath}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      mismatches.push(`JSON type mismatch at ${jsonPath}: array vs object`);
      return;
    }
    if (expected.length !== actual.length) {
      mismatches.push(`JSON array length at ${jsonPath}: expected ${expected.length}, got ${actual.length}`);
      return;
    }
    for (let i = 0; i < expected.length; i += 1) {
      diffJsonValues(expected[i], actual[i], `${jsonPath}[${i}]`, ignoreFields, mismatches);
    }
    return;
  }

  if (typeof expected === 'object' && typeof actual === 'object') {
    const expObj = expected as Record<string, unknown>;
    const actObj = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expObj), ...Object.keys(actObj)]);
    for (const key of keys) {
      const nextPath = `${jsonPath}.${key}`;
      if (!(key in expObj)) {
        mismatches.push(`Unexpected JSON key at ${nextPath}`);
        continue;
      }
      if (!(key in actObj)) {
        mismatches.push(`Missing JSON key at ${nextPath}`);
        continue;
      }
      if (ignoreFields.has(key)) {
        // Verify masked volatile key has matching runtime type without enforcing exact timestamp/UUID equality
        const expT = expObj[key] === null ? 'null' : typeof expObj[key];
        const actT = actObj[key] === null ? 'null' : typeof actObj[key];
        if (expT !== actT) {
          mismatches.push(`Masked JSON key type mismatch at ${nextPath}: expected ${expT}, got ${actT}`);
        }
        continue;
      }
      diffJsonValues(expObj[key], actObj[key], nextPath, ignoreFields, mismatches);
    }
    return;
  }

  mismatches.push(`JSON value mismatch at ${jsonPath}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function diffAgainstTarget(options: DiffOptions): Promise<DiffReport> {
  if (!options.targetUrl && !options.workerEntry) {
    throw new Error('diffAgainstTarget requires either targetUrl or workerEntry.');
  }

  let corpus = options.corpus;
  if (!corpus) {
    if (!options.corpusPath) {
      throw new Error('diffAgainstTarget requires either corpus or corpusPath.');
    }
    const raw = await readFile(path.resolve(options.corpusPath), 'utf8');
    corpus = JSON.parse(raw) as ReplayCorpus;
  }

  const ignoreFields = new Set(options.ignoreFields ?? ['timestamp', 'requestId']);
  const simulator = options.workerEntry
    ? await createWorkerSimulator(options.workerEntry, { migrationsDir: options.migrationsDir })
    : null;
  const targetBase = options.targetUrl ? options.targetUrl.replace(/\/+$/, '') : 'http://edge-simulator.local';

  const results: CaseDiff[] = [];
  const originLatencies: number[] = [];
  const edgeLatencies: number[] = [];

  try {
    for (const item of corpus.cases) {
      const { request, response: expected } = item;
      const fullUrl = `${targetBase}${request.pathWithQuery.startsWith('/') ? '' : '/'}${request.pathWithQuery}`;
      const webReq = new Request(fullUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      });

      let actualRes: Response;
      let edgeMs: number;
      if (simulator) {
        const out = await simulator.dispatch(webReq);
        actualRes = out.response;
        edgeMs = out.durationMs;
      } else {
        const started = performance.now();
        actualRes = await fetch(fullUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          redirect: 'manual',
        });
        edgeMs = Number((performance.now() - started).toFixed(3));
      }

      const actualBytes = new Uint8Array(await actualRes.arrayBuffer());
      const actualHeaders: Record<string, string> = {};
      actualRes.headers.forEach((value, key) => {
        actualHeaders[key.toLowerCase()] = value;
      });

      const mismatches: string[] = [];

      if (actualRes.status !== expected.status) {
        mismatches.push(`Status mismatch: expected ${expected.status}, got ${actualRes.status}`);
      }

      const expType = mediaType(expected.headers['content-type']);
      const actType = mediaType(actualHeaders['content-type']);
      if (expType && actType && expType !== actType) {
        mismatches.push(`Content-Type mismatch: expected "${expType}", got "${actType}"`);
      }

      if (expected.headers.location && actualHeaders.location !== expected.headers.location) {
        mismatches.push(
          `Location header mismatch: expected "${expected.headers.location}", got "${actualHeaders.location ?? ''}"`,
        );
      }

      if (
        expected.headers['access-control-allow-origin'] &&
        actualHeaders['access-control-allow-origin'] !== expected.headers['access-control-allow-origin']
      ) {
        mismatches.push(
          `CORS header mismatch: expected "${expected.headers['access-control-allow-origin']}", got "${actualHeaders['access-control-allow-origin'] ?? ''}"`,
        );
      }

      if (expected.isBase64) {
        const expectedBuf = Buffer.from(expected.body, 'base64');
        if (Buffer.compare(expectedBuf, actualBytes) !== 0) {
          mismatches.push(
            `Binary body mismatch: expected ${expectedBuf.byteLength} bytes, got ${actualBytes.byteLength} bytes`,
          );
        }
      } else {
        const actualText = Buffer.from(actualBytes).toString('utf8');
        const expIsJson = expType.includes('json');
        const parsedExp = expIsJson || expected.body.trim().startsWith('{') || expected.body.trim().startsWith('[')
          ? tryParseJson(expected.body)
          : ({ ok: false } as const);
        const parsedAct = parsedExp.ok ? tryParseJson(actualText) : ({ ok: false } as const);

        if (parsedExp.ok && parsedAct.ok) {
          diffJsonValues(parsedExp.value, parsedAct.value, '$', ignoreFields, mismatches);
        } else if (actualText !== expected.body) {
          mismatches.push(
            `Body mismatch: expected ${JSON.stringify(expected.body.slice(0, 120))}, got ${JSON.stringify(actualText.slice(0, 120))}`,
          );
        }
      }

      originLatencies.push(expected.durationMs);
      edgeLatencies.push(edgeMs);

      results.push({
        id: request.id,
        method: request.method,
        pathWithQuery: request.pathWithQuery,
        matched: mismatches.length === 0,
        expectedStatus: expected.status,
        actualStatus: actualRes.status,
        originMs: expected.durationMs,
        edgeMs,
        mismatches,
      });
    }
  } finally {
    simulator?.close();
  }

  const matched = results.filter((r) => r.matched).length;
  const total = results.length;
  const failed = total - matched;
  const passRate = total > 0 ? Number(((matched / total) * 100).toFixed(2)) : 0;

  const sortedOrigin = [...originLatencies].sort((a, b) => a - b);
  const sortedEdge = [...edgeLatencies].sort((a, b) => a - b);
  const originP50Ms = percentile(sortedOrigin, 50);
  const originP95Ms = percentile(sortedOrigin, 95);
  const edgeP50Ms = percentile(sortedEdge, 50);
  const edgeP95Ms = percentile(sortedEdge, 95);
  const speedupFactor = edgeP50Ms > 0 ? Number((originP50Ms / edgeP50Ms).toFixed(2)) : 1;

  return {
    total,
    matched,
    failed,
    passRate,
    originP50Ms,
    originP95Ms,
    edgeP50Ms,
    edgeP95Ms,
    speedupFactor,
    results,
  };
}
