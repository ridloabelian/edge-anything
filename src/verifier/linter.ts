import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LintFinding, LintReport } from '../types.ts';

const FORBIDDEN_MODULES = new Set([
  'child_process',
  'cluster',
  'dgram',
  'vm',
  'worker_threads',
  'inspector',
  'repl',
  'tls',
  'http2',
]);

const FS_WRITE_CALL = /\b(?:fs|fsPromises)\.(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|unlinkSync|createWriteStream)\s*\(/;
const GLOBAL_SIDE_EFFECT_CALL = /\b(?:fetch|setTimeout|setInterval)\s*\(|\bDate\.now\s*\(|\bMath\.random\s*\(|\bcrypto\.randomUUID\s*\(/;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quoteChar) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Strip trailing commas before } or ]
  return out.replace(/,\s*([}\]])/g, '$1');
}

export interface ParsedWranglerConfig {
  mainFile: string;
  hasNodejsCompat: boolean;
  declaredBindings: string[];
  rawConfig: Record<string, unknown> | null;
}

export async function parseWranglerConfig(targetDir: string): Promise<ParsedWranglerConfig> {
  const absDir = path.resolve(targetDir);
  const candidates = ['wrangler.jsonc', 'wrangler.json'];

  for (const name of candidates) {
    const filePath = path.join(absDir, name);
    if (!(await pathExists(filePath))) continue;
    const raw = await readFile(filePath, 'utf8');
    const cleaned = stripJsonComments(raw);
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const flags = Array.isArray(parsed.compatibility_flags)
      ? parsed.compatibility_flags.map(String)
      : [];
    const hasNodejsCompat = flags.includes('nodejs_compat');
    const mainFile = typeof parsed.main === 'string' ? parsed.main : 'src/index.ts';

    const bindings = new Set<string>();
    const arraySections: Array<[string, string]> = [
      ['d1_databases', 'binding'],
      ['kv_namespaces', 'binding'],
      ['r2_buckets', 'binding'],
      ['hyperdrive', 'binding'],
      ['vectorize', 'binding'],
      ['services', 'binding'],
      ['analytics_engine_datasets', 'binding'],
    ];
    for (const [section, key] of arraySections) {
      const list = parsed[section];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string') {
            bindings.add((item as Record<string, string>)[key]!);
          }
        }
      }
    }

    const queues = parsed.queues as { producers?: Array<{ binding?: string }> } | undefined;
    if (queues?.producers && Array.isArray(queues.producers)) {
      for (const p of queues.producers) {
        if (typeof p.binding === 'string') bindings.add(p.binding);
      }
    }

    const dos = parsed.durable_objects as { bindings?: Array<{ name?: string }> } | undefined;
    if (dos?.bindings && Array.isArray(dos.bindings)) {
      for (const b of dos.bindings) {
        if (typeof b.name === 'string') bindings.add(b.name);
      }
    }

    const ai = parsed.ai as { binding?: string } | undefined;
    if (ai && typeof ai.binding === 'string') bindings.add(ai.binding);

    const browser = parsed.browser as { binding?: string } | undefined;
    if (browser && typeof browser.binding === 'string') bindings.add(browser.binding);

    const vars = parsed.vars as Record<string, unknown> | undefined;
    if (vars && typeof vars === 'object') {
      for (const k of Object.keys(vars)) bindings.add(k);
    }

    return {
      mainFile,
      hasNodejsCompat,
      declaredBindings: [...bindings],
      rawConfig: parsed,
    };
  }

  return {
    mainFile: 'src/index.ts',
    hasNodejsCompat: false,
    declaredBindings: [],
    rawConfig: null,
  };
}

async function collectWorkerFiles(targetDir: string): Promise<Array<{ relPath: string; content: string; bytes: number }>> {
  const results: Array<{ relPath: string; content: string; bytes: number }> = [];
  const absRoot = path.resolve(targetDir);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.wrangler', '.edge-anything', 'dist'].includes(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.ts', '.mts', '.js', '.mjs'].includes(ext)) continue;
      if (entry.name.endsWith('.d.ts')) continue;

      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(absRoot, absPath).split(path.sep).join('/');
      const s = await stat(absPath);
      const content = await readFile(absPath, 'utf8');
      results.push({ relPath, content, bytes: s.size });
    }
  }

  const srcDir = path.join(absRoot, 'src');
  if (await pathExists(srcDir)) {
    await walk(srcDir);
  } else {
    await walk(absRoot);
  }
  return results;
}

function stripCommentsPreserveLines(code: string): string[] {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  let i = 0;

  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];

    if (inString) {
      out += ch === '\n' ? '\n' : ' ';
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quote = ch;
      out += ' ';
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.split(/\r?\n/);
}

export async function lintEdgeProject(targetDir: string): Promise<LintReport> {
  const absDir = path.resolve(targetDir);
  const findings: LintFinding[] = [];
  const config = await parseWranglerConfig(absDir);
  const files = await collectWorkerFiles(absDir);

  if (!config.rawConfig) {
    findings.push({
      severity: 'error',
      rule: 'ERR_MISSING_WRANGLER_CONFIG',
      file: 'wrangler.jsonc',
      line: 1,
      message: 'No wrangler.jsonc or wrangler.json found in target edge directory.',
      fixHint: 'Run `edge-anything port` or create wrangler.jsonc with Worker bindings.',
    });
  }

  const entryNorm = config.mainFile.replace(/^\.\//, '');
  const entryFile = files.find((f) => f.relPath === entryNorm) ?? files.find((f) => f.relPath === 'src/index.ts');

  if (!entryFile) {
    findings.push({
      severity: 'error',
      rule: 'ERR_MISSING_ENTRY',
      file: entryNorm,
      line: 1,
      message: `Entrypoint "${entryNorm}" does not exist.`,
      fixHint: `Create ${entryNorm} exporting a default { fetch(request, env, ctx) } handler.`,
    });
  } else {
    const hasDefaultExport = /\bexport\s+default\b/.test(entryFile.content);
    const hasFetchHandler = /\bfetch\s*(?:\(|:)|\bexport\s+default\s+[a-zA-Z0-9_]+\b/.test(entryFile.content);
    if (!hasDefaultExport || !hasFetchHandler) {
      findings.push({
        severity: 'error',
        rule: 'ERR_MISSING_DEFAULT_EXPORT',
        file: entryFile.relPath,
        line: 1,
        message: 'Worker entrypoint must export a default module with a fetch handler.',
        fixHint: 'Export `export default { async fetch(request: Request, env: Env): Promise<Response> { ... } };`.',
      });
    }
  }

  const declaredSet = new Set(config.declaredBindings);
  const referencedSet = new Set<string>();
  let bundleBytes = 0;

  for (const file of files) {
    bundleBytes += file.bytes;
    const rawLines = file.content.split(/\r?\n/);
    const codeLines = stripCommentsPreserveLines(file.content);

    let braceDepth = 0;

    for (let i = 0; i < rawLines.length; i += 1) {
      const rawLine = rawLines[i]!;
      const strippedLine = codeLines[i] ?? '';
      const lineNum = i + 1;

      // 1. Check imports (skip type-only imports)
      if (!/^\s*import\s+type\b/.test(rawLine)) {
        const importMatch = rawLine.match(/(?:from\s+|require\s*\(\s*)['"](node:)?([a-zA-Z0-9_/-]+)['"]/);
        if (importMatch?.[2]) {
          const hasNodePrefix = Boolean(importMatch[1]);
          const modName = importMatch[2];
          if (FORBIDDEN_MODULES.has(modName)) {
            findings.push({
              severity: 'error',
              rule: 'ERR_FORBIDDEN_NODE_BUILTIN',
              file: file.relPath,
              line: lineNum,
              message: `Module "${hasNodePrefix ? 'node:' : ''}${modName}" is disallowed in Cloudflare Workers isolates.`,
              fixHint: 'Remove OS process/socket dependencies or route workload to Cloudflare Containers.',
            });
          } else if (hasNodePrefix && !config.hasNodejsCompat) {
            findings.push({
              severity: 'error',
              rule: 'ERR_MISSING_NODEJS_COMPAT',
              file: file.relPath,
              line: lineNum,
              message: `Import "node:${modName}" requires \`compatibility_flags: ["nodejs_compat"]\` in wrangler.jsonc.`,
              fixHint: 'Add `"compatibility_flags": ["nodejs_compat"]` to wrangler.jsonc or use Web APIs.',
            });
          }
        }
      }

      if (FS_WRITE_CALL.test(rawLine)) {
        findings.push({
          severity: 'error',
          rule: 'ERR_FORBIDDEN_FS_WRITE',
          file: file.relPath,
          line: lineNum,
          message: 'Filesystem mutation is unsupported inside Workers isolates.',
          fixHint: 'Persist binary objects in R2 (env.BUCKET) or rows in D1 (env.DB).',
        });
      }

      // 2. Check env.<BINDING> references
      const envRefs = strippedLine.matchAll(/\benv\.([A-Z][A-Z0-9_]{1,})\b/g);
      for (const ref of envRefs) {
        const binding = ref[1]!;
        referencedSet.add(binding);
        if (config.rawConfig && !declaredSet.has(binding)) {
          findings.push({
            severity: 'error',
            rule: 'ERR_UNDECLARED_BINDING',
            file: file.relPath,
            line: lineNum,
            message: `Binding "env.${binding}" is referenced in code but not declared in wrangler.jsonc.`,
            fixHint: `Declare "${binding}" under the appropriate binding section in wrangler.jsonc.`,
          });
        }
      }

      // 3. Top-level global scope side-effect & mutable state checks (braceDepth === 0)
      if (braceDepth === 0) {
        if (GLOBAL_SIDE_EFFECT_CALL.test(strippedLine)) {
          findings.push({
            severity: 'error',
            rule: 'ERR_GLOBAL_SCOPE_SIDE_EFFECT',
            file: file.relPath,
            line: lineNum,
            message: 'Top-level I/O, timers, Date.now(), or random generation cannot execute in Worker global scope.',
            fixHint: 'Move this call inside `fetch()`, `scheduled()`, or `queue()`.',
          });
        }

        if (
          !rawLine.includes('edge-anything-ignore') &&
          (/^\s*(?:export\s+)?let\s+[a-zA-Z0-9_]+/.test(strippedLine) ||
            /^\s*(?:export\s+)?const\s+[a-zA-Z0-9_]+\s*=\s*new\s+(?:Map|Set)\s*\(/.test(strippedLine))
        ) {
          findings.push({
            severity: 'warning',
            rule: 'WARN_MUTABLE_GLOBAL_STATE',
            file: file.relPath,
            line: lineNum,
            message: 'Mutable module-level state leaks across requests within the same isolate and is lost on eviction.',
            fixHint: 'Move mutable state to KV, D1, or Durable Objects.',
          });
        }
      }

      for (const ch of strippedLine) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
      }
    }
  }

  if (bundleBytes > 900 * 1024) {
    findings.push({
      severity: 'warning',
      rule: 'WARN_BUNDLE_SIZE',
      file: '.',
      line: 1,
      message: `Source size (${Math.round(bundleBytes / 1024)} KB) is approaching Workers bundle size thresholds.`,
      fixHint: 'Trim unused dependencies or externalize assets to R2.',
    });
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    targetDir: absDir,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    declaredBindings: config.declaredBindings,
    referencedBindings: [...referencedSet],
    bundleBytes,
    findings,
  };
}
