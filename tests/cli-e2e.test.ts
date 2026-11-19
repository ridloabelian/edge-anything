import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startLegacyServer } from '../examples/legacy-node-api/server.ts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(repoRoot, 'bin', 'edge-anything.mjs');

describe('CLI End-to-End Subprocess Execution', () => {
  it('runs scan, port, lint, skill install --dry-run, record, and gate via bin/edge-anything.mjs --json', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'edge-anything-cli-e2e-'));
    const legacyDir = path.join(repoRoot, 'examples', 'legacy-node-api');
    const edgeDir = path.join(repoRoot, 'examples', 'edge-worker-port');
    const corpusPath = path.join(tmp, 'corpus.json');
    const portOutDir = path.join(tmp, 'ported-worker');

    const serverHandle = await startLegacyServer(0);

    try {
      const { stdout: scanStdout } = await execFileAsync(binPath, ['scan', legacyDir, '--json']);
      const scanJson = JSON.parse(scanStdout) as { routes: unknown[]; bindings: Array<{ kind: string }> };
      assert.equal(scanJson.routes.length, 12);
      assert.ok(scanJson.bindings.some((b) => b.kind === 'd1'));

      const { stdout: portStdout } = await execFileAsync(binPath, [
        'port',
        legacyDir,
        '--out',
        portOutDir,
        '--force',
        '--json',
      ]);
      const portJson = JSON.parse(portStdout) as { filesWritten: string[]; migrationsGenerated: number };
      assert.ok(portJson.filesWritten.includes('wrangler.jsonc'));
      assert.equal(portJson.migrationsGenerated, 1);

      const { stdout: lintStdout } = await execFileAsync(binPath, ['lint', edgeDir, '--json']);
      const lintJson = JSON.parse(lintStdout) as { passed: boolean; errorCount: number };
      assert.equal(lintJson.passed, true);
      assert.equal(lintJson.errorCount, 0);

      const { stdout: skillStdout } = await execFileAsync(binPath, [
        'skill',
        'install',
        '--agent',
        'all',
        '--dry-run',
        '--json',
      ]);
      const skillJson = JSON.parse(skillStdout) as { dryRun: boolean; installedPaths: string[] };
      assert.equal(skillJson.dryRun, true);
      assert.equal(skillJson.installedPaths.length, 4);

      const { stdout: recStdout } = await execFileAsync(binPath, [
        'record',
        '--url',
        serverHandle.url,
        '--spec',
        path.join(legacyDir, 'scenarios.json'),
        '--out',
        corpusPath,
        '--json',
      ]);
      const recJson = JSON.parse(recStdout) as { cases: unknown[] };
      assert.equal(recJson.cases.length, 27);

      const { stdout: gateStdout } = await execFileAsync(binPath, [
        'gate',
        edgeDir,
        '--corpus',
        corpusPath,
        '--worker',
        path.join(edgeDir, 'src', 'index.ts'),
        '--json',
      ]);
      const gateJson = JSON.parse(gateStdout) as { passed: boolean; diff: { matched: number; total: number } };
      assert.equal(gateJson.passed, true);
      assert.equal(gateJson.diff.matched, 27);
      assert.equal(gateJson.diff.total, 27);
    } finally {
      await serverHandle.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
