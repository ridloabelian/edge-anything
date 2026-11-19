import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanProject } from '../scanner/isolateAudit.ts';
import { generateShims } from './shimsGen.ts';
import { generateWranglerConfig } from './wranglerGen.ts';
import type { PortResult, RouteDescriptor, ScanReport } from '../types.ts';

export interface PortOptions {
  outDir?: string;
  force?: boolean;
  scanReport?: ScanReport;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function generateEnvDts(scan: ScanReport): string {
  const lines: string[] = ['export interface Env {'];
  for (const binding of scan.bindings) {
    if (binding.kind === 'd1') lines.push(`  ${binding.bindingName}: import('./shims/d1.ts').D1LikeDatabase;`);
    else if (binding.kind === 'kv') lines.push(`  ${binding.bindingName}: import('./shims/kv.ts').KVLikeNamespace;`);
    else if (binding.kind === 'r2') lines.push(`  ${binding.bindingName}: import('./shims/r2.ts').R2LikeBucket;`);
    else if (binding.kind === 'queues') lines.push(`  ${binding.bindingName}: import('./shims/queue.ts').QueueLike;`);
    else lines.push(`  ${binding.bindingName}: unknown;`);
  }
  lines.push('  [key: string]: unknown;');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function generateWorkerEntry(scan: ScanReport): string {
  const routes: RouteDescriptor[] =
    scan.routes.length > 0
      ? scan.routes
      : [{ method: 'GET', path: '/health', file: 'src/index.ts', line: 1 }];

  const routeEntries = routes
    .map((r) => `  { method: ${JSON.stringify(r.method)}, pattern: ${JSON.stringify(r.path)} },`)
    .join('\n');

  const hasCron = scan.bindings.some((b) => b.kind === 'cron');
  const hasQueue = scan.bindings.some((b) => b.kind === 'queues');

  const extraHandlers: string[] = [];
  if (hasCron) {
    extraHandlers.push(`  async scheduled(_controller: { cron: string }, _env: Env): Promise<void> {
    // TODO: Port periodic task logic from legacy cron/interval
  },`);
  }
  if (hasQueue) {
    extraHandlers.push(`  async queue(batch: { messages: Array<{ body: unknown }> }, _env: Env): Promise<void> {
    for (const _msg of batch.messages) {
      // TODO: Port background queue consumer logic
    }
  },`);
  }

  return `import type { Env } from './env.ts';

interface RouteStub {
  method: string;
  pattern: string;
}

const ROUTES: RouteStub[] = [
${routeEntries}
];

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const pParts = pattern.split('/').filter(Boolean);
  const uParts = pathname.split('/').filter(Boolean);
  if (pParts.length !== uParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i += 1) {
    const p = pParts[i]!;
    const u = uParts[i]!;
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(u);
    } else if (p !== u) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        },
      });
    }

    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const params = matchPath(route.pattern, url.pathname);
      if (params) {
        return Response.json(
          {
            ok: true,
            stub: true,
            route: route.pattern,
            method,
            params,
          },
          { status: 200 },
        );
      }
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  },
${extraHandlers.join('\n')}
};
`;
}

function generateMigrationPlan(scan: ScanReport): string {
  const bindingsTable =
    scan.bindings.length > 0
      ? scan.bindings
          .map((b) => `| \`${b.sourcePackageOrApi}\` | \`${b.kind}\` (\`env.${b.bindingName}\`) | ${b.rationale} |`)
          .join('\n')
      : '| *(none detected)* | Stateless Worker | Pure `fetch()` handler |';

  const routesTable =
    scan.routes.length > 0
      ? scan.routes.map((r) => `- \`${r.method} ${r.path}\` *(from \`${r.file}:${r.line}\`)*`).join('\n')
      : '- No HTTP routes automatically extracted — inspect entry files manually.';

  const blockersSection =
    scan.isolateIssues.length > 0
      ? scan.isolateIssues
          .map((i) => `- **[${i.severity.toUpperCase()}] ${i.code}** (\`${i.file}:${i.line}\`): ${i.message} -> ${i.remediation}`)
          .join('\n')
      : '- No isolate blockers detected.';

  return `# Edge Migration Plan

- **Source:** \`${scan.rootDir}\`
- **Detected Stack:** ${scan.language} / \`${scan.framework}\`
- **Recommended Strategy:** \`${scan.recommendedStrategy}\`
- **Edge Readiness Score:** ${scan.edgeReadinessScore}/100

## 1. Cloudflare Binding Mapping

| Legacy API / Package | Cloudflare Binding | Rationale |
| --- | --- | --- |
${bindingsTable}

## 2. Discovered Routes (${scan.routes.length})

${routesTable}

## 3. Isolate Compatibility Audit

${blockersSection}

## 4. Verification Loop

1. Implement route handlers in \`src/index.ts\` using \`src/shims/\`.
2. Run \`edge-anything lint .\` until **0 errors**.
3. Run \`edge-anything gate . --corpus <corpus.json> --worker src/index.ts\` until **100% parity (0 mismatches)**.
`;
}

export async function portProject(sourceDir: string, options: PortOptions = {}): Promise<PortResult> {
  const scan = options.scanReport ?? (await scanProject(sourceDir));
  const outDir = path.resolve(options.outDir ?? path.join(scan.rootDir, 'edge-worker'));
  const force = Boolean(options.force);
  const filesWritten: string[] = [];

  async function writeTarget(relPath: string, content: string): Promise<void> {
    const abs = path.join(outDir, relPath);
    if (!force && (await fileExists(abs))) {
      return;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    filesWritten.push(relPath);
  }

  await writeTarget('wrangler.jsonc', generateWranglerConfig(scan, outDir));
  await writeTarget('src/env.d.ts', generateEnvDts(scan));
  await writeTarget('src/index.ts', generateWorkerEntry(scan));

  const shims = generateShims(scan.bindings);
  for (const shim of shims) {
    await writeTarget(shim.relPath, shim.content);
  }

  let migrationsGenerated = 0;
  if (scan.sqlSchemas.length > 0) {
    await writeTarget('migrations/0001_init.sql', `${scan.sqlSchemas.join('\n\n')}\n`);
    migrationsGenerated = 1;
  }

  await writeTarget('MIGRATION_PLAN.md', generateMigrationPlan(scan));

  return {
    sourceDir: scan.rootDir,
    outDir,
    strategy: scan.recommendedStrategy,
    filesWritten,
    bindings: scan.bindings,
    routesStubbed: scan.routes.length,
    migrationsGenerated,
  };
}
