import type { BindingRecommendation, CloudflareBindingKind } from '../types.ts';
import type { SourceTreeData } from './detector.ts';

interface BindingRule {
  kind: CloudflareBindingKind;
  bindingName: string;
  packages: string[];
  codePatterns: RegExp[];
  confidence: 'high' | 'medium';
  rationale: string;
}

const BINDING_RULES: BindingRule[] = [
  {
    kind: 'd1',
    bindingName: 'DB',
    packages: ['better-sqlite3', 'sqlite3', 'sqlite', '@libsql/client', 'aiosqlite', 'mattn/go-sqlite3'],
    codePatterns: [/from\s+['"]node:sqlite['"]/, /require\(['"]better-sqlite3['"]\)/, /DatabaseSync\(/],
    confidence: 'high',
    rationale: 'Local SQLite databases map directly to Cloudflare D1 serverless SQL at the edge.',
  },
  {
    kind: 'hyperdrive',
    bindingName: 'HYPERDRIVE',
    packages: ['pg', 'postgres', '@neondatabase/serverless', 'mysql2', 'psycopg2', 'psycopg', 'asyncpg', 'prisma', '@prisma/client', 'drizzle-orm'],
    codePatterns: [/new\s+(?:Pool|Client)\(/, /postgres\(/, /mysql\.createPool\(/],
    confidence: 'high',
    rationale: 'TCP Postgres/MySQL pools should connect via Cloudflare Hyperdrive to avoid handshake latency and connection exhaustion.',
  },
  {
    kind: 'kv',
    bindingName: 'CACHE',
    packages: ['redis', 'ioredis', '@upstash/redis', 'node-cache', 'keyv', 'lru-cache'],
    codePatterns: [/createClient\(/, /new\s+Redis\(/, /ttlCache/i, /cache\.(?:get|set)\(/i],
    confidence: 'high',
    rationale: 'Key-value reads and TTL response caches map cleanly to Cloudflare Workers KV.',
  },
  {
    kind: 'r2',
    bindingName: 'BUCKET',
    packages: ['@aws-sdk/client-s3', 'aws-sdk', 'minio', 'multer', 'busboy', 'boto3'],
    codePatterns: [
      /PutObjectCommand|GetObjectCommand|S3Client/,
      /\b(?:fs\.)?(?:writeFileSync|writeFile|readFileSync|readFile|mkdirSync|mkdir)\b.*?(?:upload|blob|storage)/is,
    ],
    confidence: 'high',
    rationale: 'Object/blob storage and local upload directories move to zero-egress Cloudflare R2.',
  },
  {
    kind: 'queues',
    bindingName: 'JOBS',
    packages: ['bullmq', 'bull', 'amqplib', 'bee-queue', 'celery', 'dramatiq'],
    codePatterns: [/new\s+Queue\(/, /amqp\.connect\(/, /enqueueJob\(/],
    confidence: 'high',
    rationale: 'Background jobs and async message queues map to Cloudflare Queues producers/consumers.',
  },
  {
    kind: 'durable_objects',
    bindingName: 'STATE_DO',
    packages: ['ws', 'socket.io', 'engine.io', 'yjs', 'partykit'],
    codePatterns: [/new\s+WebSocketServer\(/, /io\.on\(['"]connection['"]/, /DurableObject/],
    confidence: 'high',
    rationale: 'Stateful WebSockets, collaborative rooms, and distributed locks require Cloudflare Durable Objects.',
  },
  {
    kind: 'cron',
    bindingName: 'CRON_TRIGGER',
    packages: ['node-cron', 'cron', 'node-schedule', 'apscheduler'],
    codePatterns: [/cron\.schedule\(/, /new\s+CronJob\(/, /setInterval\(/],
    confidence: 'medium',
    rationale: 'Periodic tasks move from background timers to declarative Cloudflare Workers Cron Triggers (scheduled()).',
  },
  {
    kind: 'workers_ai',
    bindingName: 'AI',
    packages: ['openai', '@anthropic-ai/sdk', '@google/genai', '@huggingface/inference'],
    codePatterns: [/new\s+OpenAI\(/, /new\s+Anthropic\(/],
    confidence: 'medium',
    rationale: 'External model calls can optionally route to Cloudflare Workers AI or AI Gateway for edge caching and failover.',
  },
];

export function inferCloudflareBindings(
  tree: SourceTreeData,
  sqlSchemas: string[],
  hasBlockerRuntime: boolean,
): BindingRecommendation[] {
  const results: BindingRecommendation[] = [];
  const deps = tree.manifests.dependencies;
  const pySet = new Set(tree.manifests.pythonPackages);
  const goSet = new Set(tree.manifests.goModules);

  for (const rule of BINDING_RULES) {
    const evidence: string[] = [];
    const matchedSources: string[] = [];

    for (const pkg of rule.packages) {
      if (pkg in deps) {
        matchedSources.push(pkg);
        evidence.push(`package.json dependency "${pkg}"`);
      } else if (pySet.has(pkg.toLowerCase())) {
        matchedSources.push(pkg);
        evidence.push(`Python dependency "${pkg}"`);
      } else if (goSet.has(pkg)) {
        matchedSources.push(pkg);
        evidence.push(`Go module "${pkg}"`);
      }
    }

    for (const file of tree.files) {
      if (file.relPath === 'package.json') continue;
      for (const pattern of rule.codePatterns) {
        if (pattern.test(file.content)) {
          evidence.push(`Pattern ${pattern.source} in ${file.relPath}`);
          break;
        }
      }
    }

    if (rule.kind === 'd1' && sqlSchemas.length > 0 && evidence.length === 0) {
      // Only default to D1 from SQL DDL if Hyperdrive/Postgres wasn't matched
      const hasPostgres = results.some((r) => r.kind === 'hyperdrive');
      if (!hasPostgres) {
        matchedSources.push('SQL DDL');
        evidence.push(`Detected ${sqlSchemas.length} CREATE TABLE/INDEX DDL statement(s)`);
      }
    }

    if (evidence.length > 0) {
      results.push({
        kind: rule.kind,
        bindingName: rule.bindingName,
        sourcePackageOrApi: matchedSources[0] ?? 'code-pattern',
        evidence: [...new Set(evidence)],
        confidence: rule.confidence,
        rationale: rule.rationale,
      });
    }
  }

  // If a Dockerfile or blocker native binary exists, recommend Cloudflare Containers
  if (tree.manifests.hasDockerfile || hasBlockerRuntime) {
    const containerEvidence: string[] = [];
    if (tree.manifests.hasDockerfile) {
      containerEvidence.push('Dockerfile present in repository');
    }
    if (hasBlockerRuntime) {
      containerEvidence.push('Native binary, child_process, or non-isolate runtime APIs detected');
    }
    results.push({
      kind: 'containers',
      bindingName: 'APP_CONTAINER',
      sourcePackageOrApi: tree.manifests.hasDockerfile ? 'Dockerfile' : 'native-runtime',
      evidence: containerEvidence,
      confidence: 'high',
      rationale:
        'Workloads requiring native binaries, arbitrary OS processes, or non-V8 runtimes can run in Cloudflare Containers behind a routing Worker.',
    });
  }

  return results;
}
