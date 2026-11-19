import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startStdioMcpServer } from './mcp/server.ts';
import { portProject } from './porter/scaffold.ts';
import { recordTraffic } from './recorder/recorder.ts';
import { scanProject } from './scanner/isolateAudit.ts';
import { installSkill } from './skill/installer.ts';
import type { AgentTarget } from './skill/installer.ts';
import { diffAgainstTarget } from './verifier/differ.ts';
import { runReleaseGate } from './verifier/gate.ts';
import { lintEdgeProject } from './verifier/linter.ts';

const VERSION = '1.0.0';

const HELP_TEXT = `edge-anything v${VERSION}
Move any backend to the edge, and prove it still behaves the same.

USAGE:
  edge-anything <command> [options]

COMMANDS:
  scan <dir> [--out <blueprint.json>] [--json]
      Analyze routes, SQL schemas, Cloudflare bindings & V8 isolate compatibility.

  record --url <origin> [--cmd <start-cmd>] [--dir <source-dir>] [--spec <scenarios.json>] [--out <corpus.json>] [--json]
      Record deterministic HTTP traffic corpus from an origin backend.

  port <source-dir> [--out <edge-dir>] [--force] [--json]
      Generate wrangler.jsonc, Worker entrypoint, shims, D1 migrations & plan.

  lint <edge-dir> [--json]
      Static Cloudflare Workers V8 isolate lint check.

  diff --corpus <corpus.json> (--worker <src/index.ts> | --url <edge-url>) [--migrations <sql-dir>] [--ignore-fields <csv>] [--json]
      Replay recorded corpus against an edge Worker and compare parity + latency.

  gate <edge-dir> --corpus <corpus.json> [--worker <src/index.ts> | --url <edge-url>] [--ignore-fields <csv>] [--json]
      Run release gate (lint + parity diff). Exits 0 only on 0 errors & 0 mismatches.

  mcp
      Start JSON-RPC 2.0 Model Context Protocol server over stdio.

  skill install [--agent claude|codex|antigravity|cursor|all] [--dir <path>] [--dry-run] [--json]
      Install the universal edge-anything Agent Skill (SKILL.md).

OPTIONS:
  --json       Output machine-readable JSON only to stdout
  --help, -h   Show this help message
  --version    Print version
`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--help' || token === '-h') {
      flags.help = true;
    } else if (token === '--version' || token === '-v') {
      flags.version = true;
    } else if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function getStrFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : undefined;
}

function outputJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgv(argv);
  const asJson = Boolean(flags.json);

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const command = positionals[0]!;

  try {
    switch (command) {
      case 'scan': {
        const targetDir = positionals[1] ?? '.';
        const report = await scanProject(targetDir);
        const outPath = getStrFlag(flags, 'out');
        if (outPath) {
          await writeFile(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        }
        if (asJson) {
          outputJson(report);
        } else {
          process.stdout.write(
            [
              `Scan: ${report.rootDir}`,
              `Stack: ${report.language} / ${report.framework} (${report.filesScanned} files)`,
              `Strategy: ${report.recommendedStrategy} (Readiness: ${report.edgeReadinessScore}/100)`,
              `Routes: ${report.routes.length} | SQL DDLs: ${report.sqlSchemas.length} | Bindings: ${report.bindings.map((b) => `${b.kind}:${b.bindingName}`).join(', ') || 'none'}`,
              `Isolate Issues: ${report.isolateIssues.length}`,
              '',
            ].join('\n'),
          );
        }
        return 0;
      }

      case 'record': {
        const originUrl = getStrFlag(flags, 'url');
        if (!originUrl) {
          throw new Error('`record` requires --url <originUrl>');
        }
        const corpus = await recordTraffic({
          originUrl,
          cmd: getStrFlag(flags, 'cmd'),
          sourceDir: getStrFlag(flags, 'dir'),
          specPath: getStrFlag(flags, 'spec'),
          outPath: getStrFlag(flags, 'out') ?? '.edge-anything/corpus.json',
        });
        if (asJson) {
          outputJson(corpus);
        } else {
          process.stdout.write(
            `Recorded ${corpus.cases.length} cases from ${corpus.originUrl} (sha256: ${corpus.sha256.slice(0, 12)}...)\n`,
          );
        }
        return 0;
      }

      case 'port': {
        const sourceDir = positionals[1] ?? '.';
        const result = await portProject(sourceDir, {
          outDir: getStrFlag(flags, 'out'),
          force: Boolean(flags.force),
        });
        if (asJson) {
          outputJson(result);
        } else {
          process.stdout.write(
            `Scaffolded ${result.filesWritten.length} file(s) -> ${result.outDir} (${result.strategy})\n`,
          );
        }
        return 0;
      }

      case 'lint': {
        const edgeDir = positionals[1] ?? '.';
        const report = await lintEdgeProject(edgeDir);
        if (asJson) {
          outputJson(report);
        } else {
          process.stdout.write(
            `Lint ${report.passed ? 'PASS' : 'FAIL'}: ${report.errorCount} error(s), ${report.warningCount} warning(s), bundle ${report.bundleBytes} bytes\n`,
          );
          for (const f of report.findings) {
            process.stdout.write(`  [${f.severity.toUpperCase()}] ${f.rule} (${f.file}:${f.line}): ${f.message}\n`);
          }
        }
        return report.passed ? 0 : 1;
      }

      case 'diff': {
        const corpusPath = getStrFlag(flags, 'corpus') ?? '.edge-anything/corpus.json';
        const ignoreRaw = getStrFlag(flags, 'ignore-fields');
        const report = await diffAgainstTarget({
          corpusPath,
          targetUrl: getStrFlag(flags, 'url'),
          workerEntry: getStrFlag(flags, 'worker'),
          migrationsDir: getStrFlag(flags, 'migrations'),
          ignoreFields: ignoreRaw ? ignoreRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        });
        if (asJson) {
          outputJson(report);
        } else {
          process.stdout.write(
            `Diff: ${report.matched}/${report.total} matched (${report.passRate}%) | Origin p50=${report.originP50Ms}ms vs Edge p50=${report.edgeP50Ms}ms (${report.speedupFactor}x)\n`,
          );
          for (const r of report.results.filter((x) => !x.matched)) {
            process.stdout.write(`  FAIL [${r.id}] ${r.method} ${r.pathWithQuery}: ${r.mismatches.join('; ')}\n`);
          }
        }
        return report.failed === 0 && report.total > 0 ? 0 : 1;
      }

      case 'gate': {
        const targetDir = positionals[1] ?? '.';
        const corpusPath = getStrFlag(flags, 'corpus') ?? '.edge-anything/corpus.json';
        const ignoreRaw = getStrFlag(flags, 'ignore-fields');
        const report = await runReleaseGate({
          targetDir,
          corpusPath,
          targetUrl: getStrFlag(flags, 'url'),
          workerEntry: getStrFlag(flags, 'worker'),
          migrationsDir: getStrFlag(flags, 'migrations'),
          ignoreFields: ignoreRaw ? ignoreRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        });
        if (asJson) {
          outputJson(report);
        } else {
          process.stdout.write(`${report.summary}\n`);
        }
        return report.passed ? 0 : 1;
      }

      case 'mcp': {
        await startStdioMcpServer();
        return 0;
      }

      case 'skill': {
        const sub = positionals[1];
        if (sub !== 'install') {
          throw new Error('Usage: edge-anything skill install [--agent claude|codex|antigravity|cursor|all] [--dir <path>] [--dry-run]');
        }
        const agent = (getStrFlag(flags, 'agent') ?? 'claude') as AgentTarget;
        const result = await installSkill({
          agent,
          dir: getStrFlag(flags, 'dir'),
          dryRun: Boolean(flags.dryRun ?? flags['dry-run']),
        });
        if (asJson) {
          outputJson(result);
        } else {
          process.stdout.write(
            `${result.dryRun ? '[dry-run] Would install' : 'Installed'} SKILL.md -> ${result.installedPaths.join(', ')}\n`,
          );
        }
        return 0;
      }

      default:
        throw new Error(`Unknown command "${command}". Run \`edge-anything --help\` for usage.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) {
      outputJson({ error: message });
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    return 1;
  }
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) {
    process.exitCode = code;
  }
}
