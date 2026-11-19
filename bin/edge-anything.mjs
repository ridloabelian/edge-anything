#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliUrl = new URL('../src/cli.ts', import.meta.url);

if (!process.execArgv.includes('--experimental-strip-types')) {
  const major = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
  const minor = Number.parseInt(process.versions.node.split('.')[1] || '0', 10);
  if (major < 22 || (major === 22 && minor < 18)) {
    const res = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', fileURLToPath(cliUrl), ...process.argv.slice(2)],
      { stdio: 'inherit' },
    );
    process.exit(res.status ?? 1);
  }
}

try {
  const mod = await import(cliUrl.href);
  if (typeof mod.main === 'function') {
    const code = await mod.main(process.argv.slice(2));
    if (typeof code === 'number' && code !== 0) {
      process.exitCode = code;
    }
  }
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    const res = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', fileURLToPath(cliUrl), ...process.argv.slice(2)],
      { stdio: 'inherit' },
    );
    process.exit(res.status ?? 1);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`edge-anything error: ${msg}\n`);
  process.exit(1);
}
