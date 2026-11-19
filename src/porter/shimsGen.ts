import type { BindingRecommendation } from '../types.ts';

export interface GeneratedFile {
  relPath: string;
  content: string;
}

const D1_SHIM = `export interface D1LikeStatement {
  bind(...values: unknown[]): D1LikeStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes?: number; last_row_id?: number } }>;
}

export interface D1LikeDatabase {
  prepare(query: string): D1LikeStatement;
  batch<T = unknown>(statements: D1LikeStatement[]): Promise<T[]>;
}

export class EdgeDB {
  private readonly db: D1LikeDatabase;

  constructor(db: D1LikeDatabase) {
    this.db = db;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = params.length > 0 ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
    const res = await stmt.all<T>();
    return res.results ?? [];
  }

  async first<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = params.length > 0 ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
    return stmt.first<T>();
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number; lastRowId: number }> {
    const stmt = params.length > 0 ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
    const res = await stmt.run();
    return {
      changes: Number(res.meta?.changes ?? 0),
      lastRowId: Number(res.meta?.last_row_id ?? 0),
    };
  }
}
`;

const KV_SHIM = `export interface KVLikeNamespace {
  get(key: string, type?: 'text' | 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class EdgeKV {
  private readonly kv: KVLikeNamespace;

  constructor(kv: KVLikeNamespace) {
    this.kv = kv;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, 'text');
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const options = ttlSeconds && ttlSeconds > 0 ? { expirationTtl: ttlSeconds } : undefined;
    await this.kv.put(key, JSON.stringify(value), options);
  }

  async del(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
`;

const R2_SHIM = `export interface R2LikeObject {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2LikeBucket {
  get(key: string): Promise<R2LikeObject | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export class EdgeStorage {
  private readonly bucket: R2LikeBucket;

  constructor(bucket: R2LikeBucket) {
    this.bucket = bucket;
  }

  async put(key: string, body: string | ArrayBuffer | Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async get(key: string): Promise<R2LikeObject | null> {
    return this.bucket.get(key);
  }

  async del(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
`;

const QUEUE_SHIM = `export interface QueueLike {
  send(message: unknown): Promise<void>;
}

export async function enqueueJob<T>(queue: QueueLike | undefined, type: string, payload: T): Promise<void> {
  if (!queue) return;
  await queue.send({
    type,
    payload,
    enqueuedAt: new Date().toISOString(),
  });
}
`;

export function generateShims(bindings: BindingRecommendation[]): GeneratedFile[] {
  const kinds = new Set(bindings.map((b) => b.kind));
  const files: GeneratedFile[] = [];
  if (kinds.has('d1')) files.push({ relPath: 'src/shims/d1.ts', content: D1_SHIM });
  if (kinds.has('kv')) files.push({ relPath: 'src/shims/kv.ts', content: KV_SHIM });
  if (kinds.has('r2')) files.push({ relPath: 'src/shims/r2.ts', content: R2_SHIM });
  if (kinds.has('queues')) files.push({ relPath: 'src/shims/queue.ts', content: QUEUE_SHIM });
  return files;
}
