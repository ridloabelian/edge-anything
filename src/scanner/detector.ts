import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedManifests, RouteDescriptor, SourceFileEntry, SourceFramework } from '../types.ts';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  '.edge-anything',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sql',
  '.py',
  '.go',
  '.json',
  '.jsonc',
  '.toml',
  '.yaml',
  '.yml',
  '.txt',
]);

const MAX_FILE_BYTES = 512 * 1024;

export interface SourceTreeData {
  rootDir: string;
  files: SourceFileEntry[];
  manifests: ParsedManifests;
}

export async function scanSourceTree(rootDir: string): Promise<SourceTreeData> {
  const resolvedRoot = path.resolve(rootDir);
  const files: SourceFileEntry[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const absPath = path.join(currentDir, entry.name);
      const relPath = path.relative(resolvedRoot, absPath).split(path.sep).join('/');
      const ext = path.extname(entry.name).toLowerCase();
      const isSpecialName = entry.name === 'Dockerfile' || entry.name === 'go.mod';

      if (!TEXT_EXTENSIONS.has(ext) && !isSpecialName) {
        continue;
      }

      const fileStat = await stat(absPath);
      if (fileStat.size > MAX_FILE_BYTES) {
        continue;
      }

      const content = await readFile(absPath, 'utf8');
      files.push({ absPath, relPath, ext, content });
    }
  }

  await walk(resolvedRoot);
  const manifests = parseManifests(files);
  return { rootDir: resolvedRoot, files, manifests };
}

function parseManifests(files: SourceFileEntry[]): ParsedManifests {
  let packageJson: Record<string, unknown> | null = null;
  const dependencies: Record<string, string> = {};
  const pythonPackages: string[] = [];
  const goModules: string[] = [];
  let hasDockerfile = false;
  let dockerfileContent = '';

  for (const file of files) {
    if (file.relPath === 'package.json') {
      try {
        const parsed = JSON.parse(file.content) as Record<string, unknown>;
        packageJson = parsed;
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const bag = parsed[section];
          if (bag && typeof bag === 'object') {
            for (const [pkg, ver] of Object.entries(bag as Record<string, unknown>)) {
              if (typeof ver === 'string') {
                dependencies[pkg] = ver;
              }
            }
          }
        }
      } catch {
        // Ignore malformed package.json during static inspection
      }
    } else if (file.relPath === 'requirements.txt') {
      for (const rawLine of file.content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const pkg = line.split(/[=<>!~[\];\s]/)[0]?.toLowerCase();
        if (pkg) pythonPackages.push(pkg);
      }
    } else if (file.relPath === 'pyproject.toml') {
      const depMatches = file.content.matchAll(/["']([a-zA-Z0-9._-]+)(?:\[[^\]]+\])?(?:[=<>!~][^"']*)?["']/g);
      for (const m of depMatches) {
        if (m[1]) pythonPackages.push(m[1].toLowerCase());
      }
    } else if (file.relPath === 'go.mod') {
      for (const line of file.content.split(/\r?\n/)) {
        const m = line.trim().match(/^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+)\s+v/);
        if (m?.[1]) goModules.push(m[1]);
      }
    } else if (path.basename(file.relPath) === 'Dockerfile') {
      hasDockerfile = true;
      dockerfileContent += `${file.content}\n`;
    }
  }

  return {
    packageJson,
    dependencies,
    pythonPackages: [...new Set(pythonPackages)],
    goModules: [...new Set(goModules)],
    hasDockerfile,
    dockerfileContent,
  };
}

export function detectLanguage(tree: SourceTreeData): string {
  const counts = { ts: 0, js: 0, py: 0, go: 0 };
  for (const file of tree.files) {
    if (file.ext === '.ts' || file.ext === '.tsx' || file.ext === '.mts' || file.ext === '.cts') counts.ts += 1;
    else if (file.ext === '.js' || file.ext === '.jsx' || file.ext === '.mjs' || file.ext === '.cjs') counts.js += 1;
    else if (file.ext === '.py') counts.py += 1;
    else if (file.ext === '.go') counts.go += 1;
  }
  if (counts.ts > 0 && counts.ts >= counts.py && counts.ts >= counts.go) return 'TypeScript';
  if (counts.js > 0 && counts.js >= counts.py && counts.js >= counts.go) return 'JavaScript';
  if (counts.py > 0 && counts.py >= counts.go) return 'Python';
  if (counts.go > 0) return 'Go';
  if (tree.manifests.hasDockerfile) return 'Docker';
  return 'Unknown';
}

export function detectFrameworkAndRoutes(tree: SourceTreeData): {
  framework: SourceFramework;
  routes: RouteDescriptor[];
  sqlSchemas: string[];
} {
  const deps = tree.manifests.dependencies;
  const pySet = new Set(tree.manifests.pythonPackages);
  const routes: RouteDescriptor[] = [];
  const sqlSchemas: string[] = [];

  let framework: SourceFramework = 'unknown';
  if ('next' in deps || tree.files.some((f) => /(?:^|\/)app\/api\/.*\/route\.[jt]sx?$/.test(f.relPath))) {
    framework = 'nextjs';
  } else if ('@nestjs/core' in deps) {
    framework = 'nestjs';
  } else if ('hono' in deps) {
    framework = 'hono';
  } else if ('fastify' in deps) {
    framework = 'fastify';
  } else if ('express' in deps) {
    framework = 'express';
  } else if ('koa' in deps) {
    framework = 'koa';
  } else if (pySet.has('fastapi') || tree.files.some((f) => f.ext === '.py' && /FastAPI\(/.test(f.content))) {
    framework = 'fastapi';
  } else if (pySet.has('flask') || tree.files.some((f) => f.ext === '.py' && /Flask\(/.test(f.content))) {
    framework = 'flask';
  } else if (tree.files.some((f) => f.ext === '.go' && /http\.HandleFunc|gin\.|echo\./.test(f.content))) {
    framework = 'go-http';
  } else if (tree.files.some((f) => /node:http|createServer\(/.test(f.content))) {
    framework = 'node-http';
  } else if (tree.manifests.hasDockerfile) {
    framework = 'dockerfile';
  }

  for (const file of tree.files) {
    extractSqlSchemas(file.content, sqlSchemas);

    // Next.js App Router API routes
    const nextApiMatch = file.relPath.match(/(?:^|\/)app(\/api\/.*)\/route\.[jt]sx?$/);
    if (nextApiMatch) {
      const apiPath = nextApiMatch[1].replace(/\[([^\]]+)\]/g, ':$1');
      const lines = file.content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const m = line.match(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/);
        if (m?.[1]) {
          addUniqueRoute(routes, { method: m[1], path: apiPath, file: file.relPath, line: idx + 1 });
        }
      });
    }

    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(file.ext)) {
      extractJsRoutes(file, routes);
      if (framework === 'unknown') {
        if (/\bexpress\(\)/.test(file.content)) framework = 'express';
        else if (/\bfastify\(/.test(file.content)) framework = 'fastify';
        else if (/new\s+Hono\(/.test(file.content)) framework = 'hono';
        else if (/createServer\(/.test(file.content)) framework = 'node-http';
      }
    } else if (file.ext === '.py') {
      extractPythonRoutes(file, routes);
    } else if (file.ext === '.go') {
      extractGoRoutes(file, routes);
    }
  }

  return { framework, routes, sqlSchemas };
}

function extractJsRoutes(file: SourceFileEntry, routes: RouteDescriptor[]): void {
  const lines = file.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    // Express / Hono / Fastify / Koa: app.get('/path', ...) or router.post('/path', ...)
    const jsRouter = line.match(
      /\b(?:app|router|server|fastify|api|v1)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/i,
    );
    if (jsRouter?.[1] && jsRouter[2]) {
      const method = jsRouter[1].toUpperCase() === 'ALL' ? 'GET' : jsRouter[1].toUpperCase();
      addUniqueRoute(routes, {
        method,
        path: jsRouter[2],
        file: file.relPath,
        line: i + 1,
      });
      continue;
    }

    // Node http.createServer pattern: method === 'GET' && pathname === '/health'
    const combinedCond = line.match(
      /method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*(?:url\.pathname|pathname|req\.url)\s*===\s*['"]([^'"]+)['"]/,
    );
    if (combinedCond?.[1] && combinedCond[2]) {
      addUniqueRoute(routes, {
        method: combinedCond[1],
        path: combinedCond[2],
        file: file.relPath,
        line: i + 1,
      });
      continue;
    }

    // Reverse order: pathname === '/health' && method === 'GET'
    const reverseCond = line.match(
      /(?:url\.pathname|pathname|req\.url)\s*===\s*['"]([^'"]+)['"]\s*&&\s*method\s*===\s*['"]([A-Z]+)['"]/,
    );
    if (reverseCond?.[1] && reverseCond[2]) {
      addUniqueRoute(routes, {
        method: reverseCond[2],
        path: reverseCond[1],
        file: file.relPath,
        line: i + 1,
      });
      continue;
    }

    // Helper matchRoute(method, pathname, 'POST', '/api/notes/:id')
    const helperMatch = line.match(
      /\bmatchRoute\s*\([^,]+,\s*[^,]+,\s*['"]([A-Z]+)['"]\s*,\s*['"]([^'"]+)['"]/,
    );
    if (helperMatch?.[1] && helperMatch[2]) {
      addUniqueRoute(routes, {
        method: helperMatch[1],
        path: helperMatch[2],
        file: file.relPath,
        line: i + 1,
      });
      continue;
    }

    // Standard route descriptor pattern: { method: 'POST', path: '/api/notes' }
    const objRoute = line.match(
      /method:\s*['"]([A-Z]+)['"]\s*,\s*path:\s*['"]([^'"]+)['"]/,
    );
    if (objRoute?.[1] && objRoute[2]) {
      addUniqueRoute(routes, {
        method: objRoute[1],
        path: objRoute[2],
        file: file.relPath,
        line: i + 1,
      });
    }
  }
}

function extractPythonRoutes(file: SourceFileEntry, routes: RouteDescriptor[]): void {
  const lines = file.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fastapiMatch = line.match(/@(?:app|router)\.(get|post|put|patch|delete|options)\s*\(\s*['"]([^'"]+)['"]/i);
    if (fastapiMatch?.[1] && fastapiMatch[2]) {
      addUniqueRoute(routes, {
        method: fastapiMatch[1].toUpperCase(),
        path: fastapiMatch[2],
        file: file.relPath,
        line: i + 1,
      });
      continue;
    }
    const flaskMatch = line.match(/@(?:app|bp)\.route\s*\(\s*['"]([^'"]+)['"](?:.*methods\s*=\s*\[([^\]]+)\])?/);
    if (flaskMatch?.[1]) {
      const methodsRaw = flaskMatch[2] || "'GET'";
      const methods = methodsRaw.match(/[A-Z]+/g) ?? ['GET'];
      for (const method of methods) {
        addUniqueRoute(routes, {
          method,
          path: flaskMatch[1],
          file: file.relPath,
          line: i + 1,
        });
      }
    }
  }
}

function extractGoRoutes(file: SourceFileEntry, routes: RouteDescriptor[]): void {
  const lines = file.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const std = line.match(/HandleFunc\s*\(\s*"([^"]+)"/);
    if (std?.[1]) {
      const parts = std[1].trim().split(/\s+/);
      const method = parts.length === 2 ? parts[0]! : 'GET';
      const routePath = parts.length === 2 ? parts[1]! : parts[0]!;
      addUniqueRoute(routes, { method: method.toUpperCase(), path: routePath, file: file.relPath, line: i + 1 });
      continue;
    }
    const frameworkMatch = line.match(/\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/);
    if (frameworkMatch?.[1] && frameworkMatch[2]) {
      addUniqueRoute(routes, {
        method: frameworkMatch[1],
        path: frameworkMatch[2],
        file: file.relPath,
        line: i + 1,
      });
    }
  }
}

function extractSqlSchemas(content: string, sqlSchemas: string[]): void {
  const matches = content.matchAll(/CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[\s\S]*?;/gi);
  for (const m of matches) {
    const ddl = m[0].trim();
    if (!sqlSchemas.includes(ddl)) {
      sqlSchemas.push(ddl);
    }
  }
}

function addUniqueRoute(routes: RouteDescriptor[], candidate: RouteDescriptor): void {
  if (!candidate.path.startsWith('/')) return;
  const exists = routes.some((r) => r.method === candidate.method && r.path === candidate.path);
  if (!exists) {
    routes.push(candidate);
  }
}
