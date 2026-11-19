import { inferCloudflareBindings } from './bindings.ts';
import { detectFrameworkAndRoutes, detectLanguage, scanSourceTree } from './detector.ts';
import type { IsolateIssue, ScanReport, SourceFileEntry, TargetStrategy } from '../types.ts';

const NODE_COMPAT_MODULES = new Set([
  'crypto',
  'buffer',
  'events',
  'stream',
  'util',
  'path',
  'url',
  'assert',
  'async_hooks',
  'querystring',
  'string_decoder',
  'zlib',
]);

const BLOCKER_MODULES = new Set([
  'child_process',
  'cluster',
  'dgram',
  'vm',
  'worker_threads',
  'inspector',
  'repl',
  'tls',
]);

const NATIVE_ADDON_PACKAGES = new Set([
  'sharp',
  'bcrypt',
  'canvas',
  'puppeteer',
  'playwright',
  'sqlite3',
  'better-sqlite3',
]);

const FS_WRITE_PATTERN = /\b(?:(?:fs|fsPromises)\.)?(?:writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|createWriteStream)\s*\(|\b(?:fs|fsPromises)\.(?:writeFile|appendFile|mkdir)\s*\(/;
const FS_READ_PATTERN = /\b(?:(?:fs|fsPromises)\.)?(?:readFileSync|readdirSync)\s*\(|\b(?:fs|fsPromises)\.(?:readFile|readdir)\s*\(/;

export function auditIsolateCompatibility(
  files: SourceFileEntry[],
  dependencies: Record<string, string>,
  language: string,
): {
  issues: IsolateIssue[];
  requiresNodejsCompat: boolean;
  hasBlocker: boolean;
} {
  const issues: IsolateIssue[] = [];
  let requiresNodejsCompat = false;
  let hasBlocker = false;

  for (const pkg of Object.keys(dependencies)) {
    if (NATIVE_ADDON_PACKAGES.has(pkg)) {
      const isSqlite = pkg === 'better-sqlite3' || pkg === 'sqlite3';
      issues.push({
        severity: isSqlite ? 'warning' : 'blocker',
        code: isSqlite ? 'WARN_NATIVE_SQLITE' : 'BLOCKER_NATIVE_ADDON',
        file: 'package.json',
        line: 1,
        symbol: pkg,
        message: isSqlite
          ? `Native SQLite driver "${pkg}" cannot load inside V8 isolates.`
          : `Native C++/binary dependency "${pkg}" cannot run inside a V8 isolate.`,
        remediation: isSqlite
          ? 'Replace with Cloudflare D1 (env.DB) using src/shims/d1.ts.'
          : 'Offload to Cloudflare Images/Browser Rendering/WebCrypto, or wrap in a Cloudflare Container.',
      });
      if (!isSqlite) hasBlocker = true;
    }
  }

  for (const file of files) {
    if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(file.ext)) {
      continue;
    }
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const isTypeImport = /^\s*import\s+type\b/.test(line);
      const importMatch = isTypeImport
        ? null
        : line.match(/(?:from\s+|require\s*\(\s*)['"](?:node:)?([a-zA-Z0-9_/-]+)['"]/);
      if (importMatch?.[1]) {
        const mod = importMatch[1];
        if (BLOCKER_MODULES.has(mod)) {
          hasBlocker = true;
          issues.push({
            severity: 'blocker',
            code: 'BLOCKER_FORBIDDEN_BUILTIN',
            file: file.relPath,
            line: i + 1,
            symbol: `node:${mod}`,
            message: `Module "${mod}" is unsupported in Cloudflare Workers isolates.`,
            remediation: 'Replace process spawning/sockets with Queues, Fetch, Durable Objects, or Cloudflare Containers.',
          });
        } else if (mod === 'sqlite') {
          issues.push({
            severity: 'warning',
            code: 'WARN_NODE_SQLITE',
            file: file.relPath,
            line: i + 1,
            symbol: 'node:sqlite',
            message: 'node:sqlite uses local SQLite storage and must be migrated to D1.',
            remediation: 'Migrate queries to env.DB (Cloudflare D1) via src/shims/d1.ts.',
          });
        } else if (mod === 'http' || mod === 'https' || mod === 'net') {
          issues.push({
            severity: 'warning',
            code: 'WARN_NODE_SERVER',
            file: file.relPath,
            line: i + 1,
            symbol: `node:${mod}`,
            message: `Node server/socket module "${mod}" should be replaced by Web Fetch / fetch() in Workers.`,
            remediation: 'Export `default { async fetch(request, env, ctx) }` and use standard Web APIs.',
          });
        } else if (NODE_COMPAT_MODULES.has(mod)) {
          requiresNodejsCompat = true;
          issues.push({
            severity: 'compat',
            code: 'COMPAT_NODEJS_FLAG',
            file: file.relPath,
            line: i + 1,
            symbol: `node:${mod}`,
            message: `Module "node:${mod}" requires \`compatibility_flags: ["nodejs_compat"]\` in wrangler.jsonc.`,
            remediation: 'Add `"compatibility_flags": ["nodejs_compat"]` or switch to Web Crypto / Web Streams.',
          });
        }
      }

      if (FS_WRITE_PATTERN.test(line)) {
        hasBlocker = true;
        issues.push({
          severity: 'blocker',
          code: 'BLOCKER_LOCAL_FS_WRITE',
          file: file.relPath,
          line: i + 1,
          symbol: 'fs.write',
          message: 'Cloudflare Workers isolates have no writable persistent local filesystem.',
          remediation: 'Store blobs in Cloudflare R2 (env.BUCKET) or structured state in D1/KV.',
        });
      } else if (FS_READ_PATTERN.test(line)) {
        issues.push({
          severity: 'warning',
          code: 'WARN_LOCAL_FS_READ',
          file: file.relPath,
          line: i + 1,
          symbol: 'fs.read',
          message: 'Filesystem read detected; Workers cannot read arbitrary disk paths at runtime.',
          remediation: 'Bundle static assets, embed SQL migrations, or read objects from R2/KV.',
        });
      }
    }
  }

  if (language === 'Go' || language === 'Docker') {
    hasBlocker = true;
  } else if (language === 'Python') {
    issues.push({
      severity: 'warning',
      code: 'WARN_PYTHON_WORKERS',
      file: '.',
      line: 1,
      symbol: 'Python',
      message: 'Python apps require Cloudflare Python Workers (Pyodide) or porting/containerizing.',
      remediation: 'Use Python Workers for pure-Python endpoints or port hot paths to TypeScript Workers / Containers.',
    });
  }

  return { issues, requiresNodejsCompat, hasBlocker };
}

export async function scanProject(targetDir: string): Promise<ScanReport> {
  const tree = await scanSourceTree(targetDir);
  const language = detectLanguage(tree);
  const { framework, routes, sqlSchemas } = detectFrameworkAndRoutes(tree);
  const { issues, requiresNodejsCompat, hasBlocker } = auditIsolateCompatibility(
    tree.files,
    tree.manifests.dependencies,
    language,
  );
  const requiresContainers = hasBlocker && (tree.manifests.hasDockerfile || language === 'Go' || issues.some((i) => i.code === 'BLOCKER_FORBIDDEN_BUILTIN' || i.code === 'BLOCKER_NATIVE_ADDON'));
  const bindings = inferCloudflareBindings(tree, sqlSchemas, requiresContainers);

  const uniqueByCategory = new Map<string, IsolateIssue['severity']>();
  for (const issue of issues) {
    uniqueByCategory.set(`${issue.code}:${issue.symbol}`, issue.severity);
  }
  const severities = [...uniqueByCategory.values()];
  const blockerCount = severities.filter((s) => s === 'blocker').length;
  const warningCount = severities.filter((s) => s === 'warning').length;
  const compatCount = severities.filter((s) => s === 'compat').length;

  let score = 100 - blockerCount * 22 - warningCount * 8 - compatCount * 3;
  if (language === 'Python') score -= 10;
  if (language === 'Go' || language === 'Docker') score -= 20;
  score = Math.max(10, Math.min(100, score));

  let recommendedStrategy: TargetStrategy = 'workers-native';
  if (requiresContainers) {
    recommendedStrategy = 'workers-hybrid-containers';
  } else if (requiresNodejsCompat) {
    recommendedStrategy = 'workers-nodejs-compat';
  }

  return {
    rootDir: tree.rootDir,
    scannedAt: new Date().toISOString(),
    language,
    framework,
    filesScanned: tree.files.length,
    routes,
    sqlSchemas,
    bindings,
    isolateIssues: issues,
    requiresNodejsCompat,
    requiresContainers,
    edgeReadinessScore: score,
    recommendedStrategy,
  };
}
