import { portProject } from '../porter/scaffold.ts';
import { recordTraffic } from '../recorder/recorder.ts';
import { scanProject } from '../scanner/isolateAudit.ts';
import { diffAgainstTarget } from '../verifier/differ.ts';
import { runReleaseGate } from '../verifier/gate.ts';
import { lintEdgeProject } from '../verifier/linter.ts';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const BINDING_GUIDES: Record<string, Record<string, unknown>> = {
  d1: {
    binding: 'DB (D1Database)',
    replaces: ['better-sqlite3', 'sqlite3', 'node:sqlite', '@libsql/client'],
    wranglerKey: 'd1_databases',
    pattern: 'await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first()',
    gotchas: [
      'D1 queries are always async (await prepare().bind().all()/first()/run()).',
      'Use migrations/*.sql and `wrangler d1 migrations apply` instead of runtime CREATE TABLE.',
      'Prefer batch() for multi-statement transactions.',
    ],
  },
  hyperdrive: {
    binding: 'HYPERDRIVE (Hyperdrive)',
    replaces: ['pg', 'postgres', 'mysql2', 'prisma', 'drizzle-orm'],
    wranglerKey: 'hyperdrive',
    pattern: 'new Client({ connectionString: env.HYPERDRIVE.connectionString })',
    gotchas: [
      'Requires `compatibility_flags: ["nodejs_compat"]` when using pg/postgres drivers.',
      'Instantiate TCP clients inside fetch(), never in global scope.',
    ],
  },
  kv: {
    binding: 'CACHE (KVNamespace)',
    replaces: ['redis', 'ioredis', 'node-cache', 'lru-cache'],
    wranglerKey: 'kv_namespaces',
    pattern: 'await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: 300 })',
    gotchas: [
      'KV is eventually consistent; use D1 or Durable Objects for strongly consistent counters/locks.',
      'Minimum expirationTtl is 60 seconds in Cloudflare production.',
    ],
  },
  r2: {
    binding: 'BUCKET (R2Bucket)',
    replaces: ['@aws-sdk/client-s3', 'minio', 'multer', 'local fs uploads'],
    wranglerKey: 'r2_buckets',
    pattern: 'await env.BUCKET.put(key, body, { httpMetadata: { contentType } })',
    gotchas: [
      'Workers have no persistent disk; store uploaded files and binary assets in R2.',
      'Preserve Content-Type via httpMetadata so downloads match origin headers.',
    ],
  },
  queues: {
    binding: 'JOBS (Queue)',
    replaces: ['bullmq', 'bull', 'amqplib', 'celery'],
    wranglerKey: 'queues.producers',
    pattern: 'await env.JOBS.send({ type: "email.send", payload })',
    gotchas: [
      'Move heavy background work out of request handlers or ctx.waitUntil() into queue() consumers.',
    ],
  },
  durable_objects: {
    binding: 'STATE_DO (DurableObjectNamespace)',
    replaces: ['ws', 'socket.io', 'in-memory locks', 'rate-limiter state'],
    wranglerKey: 'durable_objects.bindings',
    pattern: 'const stub = env.STATE_DO.get(env.STATE_DO.idFromName(roomId)); return stub.fetch(request);',
    gotchas: [
      'Export the Durable Object class from src/index.ts and configure migrations in wrangler.jsonc.',
    ],
  },
  containers: {
    binding: 'APP_CONTAINER (Container)',
    replaces: ['Dockerfile', 'child_process', 'native C++ addons', 'ffmpeg/puppeteer'],
    wranglerKey: 'containers',
    pattern: 'Route native/heavy requests from a lightweight routing Worker into the Container binding.',
    gotchas: [
      'Use Hybrid Strategy: keep auth, routing, and caching in V8 Workers while delegating native binaries to Containers.',
    ],
  },
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'edge_scan',
    description:
      'Scan a legacy backend repository to detect framework, HTTP routes, SQL DDL schemas, Cloudflare binding recommendations, isolate blockers, and edge readiness score.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Path to the source repository to scan.' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
  },
  {
    name: 'edge_port',
    description:
      'Generate Cloudflare Workers scaffold (wrangler.jsonc, src/index.ts, src/env.d.ts, src/shims/*, migrations/, and MIGRATION_PLAN.md) from a source repository.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceDir: { type: 'string', description: 'Path to legacy backend repository.' },
        outDir: { type: 'string', description: 'Output directory for generated Cloudflare Worker.' },
        force: { type: 'boolean', description: 'Overwrite existing files if true.' },
      },
      required: ['sourceDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'edge_record',
    description:
      'Record HTTP request/response behavioral corpus from a running legacy server or command into a JSON replay file.',
    inputSchema: {
      type: 'object',
      properties: {
        originUrl: { type: 'string', description: 'Origin base URL (e.g., http://127.0.0.1:3000).' },
        cmd: { type: 'string', description: 'Optional command to spawn and tear down the legacy server.' },
        sourceDir: { type: 'string', description: 'Optional source dir to auto-discover probe routes.' },
        specPath: { type: 'string', description: 'Optional JSON scenario spec path.' },
        outPath: { type: 'string', description: 'Optional path to write the recorded corpus JSON.' },
      },
      required: ['originUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'edge_lint',
    description:
      'Run static Cloudflare Workers V8 isolate lint checks against an edge project (global side effects, undeclared bindings, forbidden Node builtins, missing default export).',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Path to the edge Worker directory.' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
  },
  {
    name: 'edge_diff',
    description:
      'Replay recorded traffic corpus against an edge Worker entrypoint (local simulator) or live Workers URL and report status/header/JSON parity diffs and latencies.',
    inputSchema: {
      type: 'object',
      properties: {
        corpusPath: { type: 'string', description: 'Path to recorded corpus JSON.' },
        workerEntry: { type: 'string', description: 'Path to Worker entry file (e.g., src/index.ts) for local simulation.' },
        targetUrl: { type: 'string', description: 'Live Worker base URL if testing over HTTP instead of local simulator.' },
        migrationsDir: { type: 'string', description: 'Optional SQL migrations directory for simulated D1.' },
        ignoreFields: {
          type: 'array',
          items: { type: 'string' },
          description: 'JSON keys to type-check without strict equality (e.g., ["timestamp", "requestId"]).',
        },
      },
      required: ['corpusPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'edge_gate',
    description:
      'Run the full release gate (edge_lint + edge_diff). Passes only with 0 lint errors and 100% behavioral parity (0 mismatches).',
    inputSchema: {
      type: 'object',
      properties: {
        targetDir: { type: 'string', description: 'Path to the edge Worker project directory.' },
        corpusPath: { type: 'string', description: 'Path to recorded corpus JSON.' },
        workerEntry: { type: 'string', description: 'Optional path to Worker entrypoint (defaults to <targetDir>/src/index.ts).' },
        targetUrl: { type: 'string', description: 'Optional live Worker URL.' },
        ignoreFields: { type: 'array', items: { type: 'string' } },
      },
      required: ['targetDir', 'corpusPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'edge_binding_guide',
    description:
      'Retrieve idiomatic Cloudflare migration patterns, wrangler configuration, and isolate gotchas for a specific binding kind (d1, hyperdrive, kv, r2, queues, durable_objects, containers).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Binding kind (d1, hyperdrive, kv, r2, queues, durable_objects, containers, or all).',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
];

export async function executeMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'edge_scan': {
      return scanProject(String(args.dir));
    }
    case 'edge_port': {
      return portProject(String(args.sourceDir), {
        outDir: typeof args.outDir === 'string' ? args.outDir : undefined,
        force: Boolean(args.force),
      });
    }
    case 'edge_record': {
      return recordTraffic({
        originUrl: String(args.originUrl),
        cmd: typeof args.cmd === 'string' ? args.cmd : undefined,
        sourceDir: typeof args.sourceDir === 'string' ? args.sourceDir : undefined,
        specPath: typeof args.specPath === 'string' ? args.specPath : undefined,
        outPath: typeof args.outPath === 'string' ? args.outPath : undefined,
      });
    }
    case 'edge_lint': {
      return lintEdgeProject(String(args.dir));
    }
    case 'edge_diff': {
      return diffAgainstTarget({
        corpusPath: String(args.corpusPath),
        workerEntry: typeof args.workerEntry === 'string' ? args.workerEntry : undefined,
        targetUrl: typeof args.targetUrl === 'string' ? args.targetUrl : undefined,
        migrationsDir: typeof args.migrationsDir === 'string' ? args.migrationsDir : undefined,
        ignoreFields: Array.isArray(args.ignoreFields) ? args.ignoreFields.map(String) : undefined,
      });
    }
    case 'edge_gate': {
      return runReleaseGate({
        targetDir: String(args.targetDir),
        corpusPath: String(args.corpusPath),
        workerEntry: typeof args.workerEntry === 'string' ? args.workerEntry : undefined,
        targetUrl: typeof args.targetUrl === 'string' ? args.targetUrl : undefined,
        ignoreFields: Array.isArray(args.ignoreFields) ? args.ignoreFields.map(String) : undefined,
      });
    }
    case 'edge_binding_guide': {
      const kind = String(args.kind ?? 'all').toLowerCase();
      if (kind === 'all') return BINDING_GUIDES;
      const guide = BINDING_GUIDES[kind];
      if (!guide) {
        throw new Error(`Unknown binding kind "${kind}". Valid values: ${Object.keys(BINDING_GUIDES).join(', ')}, all`);
      }
      return guide;
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}
