import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseWranglerConfig } from './linter.ts';

export interface SimulatedD1 {
  prepare(sql: string): SimulatedD1Statement;
  batch<T = unknown>(statements: SimulatedD1Statement[]): Promise<T[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  close(): void;
}

export interface SimulatedD1Statement {
  bind(...values: unknown[]): SimulatedD1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, number> }>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; results: unknown[]; meta: { changes: number; last_row_id: number; duration: number } }>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface SimulatedKV {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer'): Promise<unknown>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string; expiration?: number }>; list_complete: boolean }>;
}

export interface SimulatedR2Object {
  key: string;
  size: number;
  etag: string;
  httpMetadata: { contentType?: string };
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SimulatedR2 {
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<SimulatedR2Object>;
  get(key: string): Promise<SimulatedR2Object | null>;
  head(key: string): Promise<Omit<SimulatedR2Object, 'text' | 'json' | 'arrayBuffer'> | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string; size: number; etag: string }>; truncated: boolean }>;
}

export interface SimulatedQueue {
  messages: unknown[];
  send(body: unknown): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
}

export interface SimulatorEnv extends Record<string, unknown> {
  DB?: SimulatedD1;
  CACHE?: SimulatedKV;
  BUCKET?: SimulatedR2;
  JOBS?: SimulatedQueue;
}

export interface WorkerSimulator {
  env: SimulatorEnv;
  dispatch(request: Request): Promise<{ response: Response; durationMs: number }>;
  runScheduled(cron?: string): Promise<void>;
  close(): void;
}

export interface CreateSimulatorOptions {
  migrationsDir?: string;
  envOverrides?: Record<string, unknown>;
}

let simInstanceCounter = 0;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function normalizeSqlArg(val: unknown): string | number | bigint | Uint8Array | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'number' || typeof val === 'bigint' || typeof val === 'string') return val;
  if (val instanceof Uint8Array) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  return JSON.stringify(val);
}

export async function createMemoryD1(migrationsDir?: string): Promise<SimulatedD1> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');

  if (migrationsDir && (await pathExists(migrationsDir))) {
    const entries = await readdir(migrationsDir);
    const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();
    for (const file of sqlFiles) {
      const ddl = await readFile(path.join(migrationsDir, file), 'utf8');
      if (ddl.trim()) {
        db.exec(ddl);
      }
    }
  }

  function makeStatement(sql: string, args: Array<string | number | bigint | Uint8Array | null>): SimulatedD1Statement & {
    _sql: string;
    _args: Array<string | number | bigint | Uint8Array | null>;
  } {
    const stmtObj = {
      _sql: sql,
      _args: args,
      bind(...values: unknown[]) {
        return makeStatement(sql, values.map(normalizeSqlArg));
      },
      async all<T = Record<string, unknown>>() {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...args).map((row) => ({ ...(row as Record<string, unknown>) })) as T[];
        return {
          results: rows,
          success: true,
          meta: { duration: 0, changes: 0, last_row_id: 0 },
        };
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const stmt = db.prepare(sql);
        const row = stmt.get(...args) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) {
          return (row[colName] ?? null) as T | null;
        }
        return { ...row } as T;
      },
      async run() {
        const stmt = db.prepare(sql);
        const info = stmt.run(...args) as { changes?: number | bigint; lastInsertRowid?: number | bigint };
        return {
          success: true,
          results: [],
          meta: {
            duration: 0,
            changes: Number(info.changes ?? 0),
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        };
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        const stmt = db.prepare(sql);
        return stmt.all(...args).map((row) => Object.values(row as Record<string, unknown>)) as T[];
      },
    };
    return stmtObj;
  }

  return {
    prepare(sql: string) {
      return makeStatement(sql, []);
    },
    async batch<T = unknown>(statements: SimulatedD1Statement[]): Promise<T[]> {
      const out: T[] = [];
      for (const s of statements) {
        const internal = s as SimulatedD1Statement & { _sql?: string };
        const isQuery = /^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(internal._sql ?? '');
        out.push((isQuery ? await s.all() : await s.run()) as T);
      }
      return out;
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    close() {
      try {
        db.close();
      } catch {
        // Already closed
      }
    },
  };
}

export function createMemoryKV(): SimulatedKV {
  const store = new Map<string, { value: Uint8Array; expiresAt?: number }>();

  function getFresh(key: string): Uint8Array | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key: string, type: 'text' | 'json' | 'arrayBuffer' = 'text') {
      const raw = getFresh(key);
      if (!raw) return null;
      if (type === 'arrayBuffer') {
        return raw.slice().buffer;
      }
      const text = new TextDecoder().decode(raw);
      if (type === 'json') {
        return JSON.parse(text);
      }
      return text;
    },
    async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { expirationTtl?: number }) {
      let bytes: Uint8Array;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof Uint8Array) {
        bytes = value.slice();
      } else {
        bytes = new Uint8Array(value.slice(0));
      }
      const expiresAt =
        options?.expirationTtl && options.expirationTtl > 0
          ? Date.now() + options.expirationTtl * 1000
          : undefined;
      store.set(key, { value: bytes, expiresAt });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      const keys: Array<{ name: string; expiration?: number }> = [];
      for (const [k, v] of store.entries()) {
        if (v.expiresAt !== undefined && Date.now() >= v.expiresAt) {
          store.delete(k);
          continue;
        }
        if (k.startsWith(prefix)) {
          keys.push({ name: k, ...(v.expiresAt ? { expiration: Math.floor(v.expiresAt / 1000) } : {}) });
        }
      }
      keys.sort((a, b) => a.name.localeCompare(b.name));
      return { keys, list_complete: true };
    },
  };
}

export function createMemoryR2(): SimulatedR2 {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; contentType?: string }>();

  async function toBytes(value: string | ArrayBuffer | Uint8Array | ReadableStream | null): Promise<Uint8Array> {
    if (value === null) return new Uint8Array(0);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value.slice();
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    const res = new Response(value);
    return new Uint8Array(await res.arrayBuffer());
  }

  function makeObject(key: string, entry: { bytes: Uint8Array; etag: string; contentType?: string }): SimulatedR2Object {
    return {
      key,
      size: entry.bytes.byteLength,
      etag: entry.etag,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : {},
      async text() {
        return new TextDecoder().decode(entry.bytes);
      },
      async json<T = unknown>() {
        return JSON.parse(new TextDecoder().decode(entry.bytes)) as T;
      },
      async arrayBuffer() {
        return entry.bytes.slice().buffer;
      },
    };
  }

  return {
    async put(key, value, options) {
      const bytes = await toBytes(value);
      const etag = createHash('md5').update(bytes).digest('hex');
      const entry = {
        bytes,
        etag,
        contentType: options?.httpMetadata?.contentType,
      };
      objects.set(key, entry);
      return makeObject(key, entry);
    },
    async get(key) {
      const entry = objects.get(key);
      return entry ? makeObject(key, entry) : null;
    },
    async head(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.bytes.byteLength,
        etag: entry.etag,
        httpMetadata: entry.contentType ? { contentType: entry.contentType } : {},
      };
    },
    async delete(keyOrKeys) {
      const list = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const k of list) objects.delete(k);
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      const out: Array<{ key: string; size: number; etag: string }> = [];
      for (const [k, v] of objects.entries()) {
        if (k.startsWith(prefix)) {
          out.push({ key: k, size: v.bytes.byteLength, etag: v.etag });
        }
      }
      out.sort((a, b) => a.key.localeCompare(b.key));
      return { objects: out, truncated: false };
    },
  };
}

export function createMemoryQueue(): SimulatedQueue {
  const messages: unknown[] = [];
  return {
    messages,
    async send(body: unknown) {
      messages.push(body);
    },
    async sendBatch(batch: Array<{ body: unknown }>) {
      for (const item of batch) messages.push(item.body);
    },
  };
}

export async function createWorkerSimulator(
  workerEntryPath: string,
  options: CreateSimulatorOptions = {},
): Promise<WorkerSimulator> {
  const absEntry = path.resolve(workerEntryPath);
  const projectDir = await findWorkerProjectRoot(path.dirname(absEntry));
  const wrangler = await parseWranglerConfig(projectDir);

  let migrationsDir = options.migrationsDir ? path.resolve(options.migrationsDir) : undefined;
  if (!migrationsDir) {
    const defaultMig = path.join(projectDir, 'migrations');
    if (await pathExists(defaultMig)) {
      migrationsDir = defaultMig;
    }
  }

  const d1Bindings = new Set<string>(['DB']);
  const kvBindings = new Set<string>(['CACHE']);
  const r2Bindings = new Set<string>(['BUCKET']);
  const queueBindings = new Set<string>(['JOBS']);

  const raw = wrangler.rawConfig;
  if (raw) {
    const collect = (arr: unknown, key: string, target: Set<string>) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string') {
          target.add((item as Record<string, string>)[key]!);
        }
      }
    };
    collect(raw.d1_databases, 'binding', d1Bindings);
    collect(raw.kv_namespaces, 'binding', kvBindings);
    collect(raw.r2_buckets, 'binding', r2Bindings);
    const producers = (raw.queues as { producers?: unknown } | undefined)?.producers;
    collect(producers, 'binding', queueBindings);
  }

  const d1Instances: SimulatedD1[] = [];
  const env: SimulatorEnv = {};

  const primaryD1 = await createMemoryD1(migrationsDir);
  d1Instances.push(primaryD1);
  for (const name of d1Bindings) {
    env[name] = primaryD1;
  }
  for (const name of kvBindings) {
    env[name] = createMemoryKV();
  }
  for (const name of r2Bindings) {
    env[name] = createMemoryR2();
  }
  for (const name of queueBindings) {
    env[name] = createMemoryQueue();
  }

  if (raw?.vars && typeof raw.vars === 'object') {
    Object.assign(env, raw.vars as Record<string, unknown>);
  }
  if (options.envOverrides) {
    Object.assign(env, options.envOverrides);
  }

  const modUrl = `${pathToFileURL(absEntry).href}?sim=${++simInstanceCounter}`;
  const mod = (await import(modUrl)) as {
    default?: {
      fetch?: (req: Request, env: SimulatorEnv, ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void }) => Promise<Response> | Response;
      scheduled?: (controller: { cron: string; scheduledTime: number }, env: SimulatorEnv, ctx: { waitUntil(p: Promise<unknown>): void }) => Promise<void> | void;
    };
  };

  if (typeof mod.default?.fetch !== 'function') {
    for (const db of d1Instances) db.close();
    throw new Error(`Worker entrypoint "${absEntry}" does not export a default { fetch() } handler.`);
  }

  const fetchHandler = mod.default.fetch;
  const scheduledHandler = mod.default.scheduled;

  return {
    env,
    async dispatch(request: Request) {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(p: Promise<unknown>) {
          pending.push(Promise.resolve(p));
        },
        passThroughOnException() {
          // no-op in simulator
        },
      };
      const started = performance.now();
      const response = await fetchHandler.call(mod.default, request, env, ctx);
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      const durationMs = Number((performance.now() - started).toFixed(3));
      return { response, durationMs };
    },
    async runScheduled(cron = '*/15 * * * *') {
      if (!scheduledHandler) return;
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(p: Promise<unknown>) {
          pending.push(Promise.resolve(p));
        },
      };
      await scheduledHandler.call(mod.default, { cron, scheduledTime: Date.now() }, env, ctx);
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
    },
    close() {
      for (const db of d1Instances) db.close();
    },
  };
}

async function findWorkerProjectRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      (await pathExists(path.join(current, 'wrangler.jsonc'))) ||
      (await pathExists(path.join(current, 'wrangler.json')))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}
