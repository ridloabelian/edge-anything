import path from 'node:path';
import { diffAgainstTarget } from './differ.ts';
import { lintEdgeProject } from './linter.ts';
import type { GateReport, ReplayCorpus } from '../types.ts';

export interface GateOptions {
  targetDir: string;
  corpus?: ReplayCorpus;
  corpusPath?: string;
  targetUrl?: string;
  workerEntry?: string;
  migrationsDir?: string;
  ignoreFields?: string[];
}

export async function runReleaseGate(options: GateOptions): Promise<GateReport> {
  const absDir = path.resolve(options.targetDir);
  const lint = await lintEdgeProject(absDir);
  const workerEntry =
    options.workerEntry ??
    (!options.targetUrl ? path.join(absDir, 'src/index.ts') : undefined);

  const diff = await diffAgainstTarget({
    corpus: options.corpus,
    corpusPath: options.corpusPath,
    targetUrl: options.targetUrl,
    workerEntry,
    migrationsDir: options.migrationsDir ?? path.join(absDir, 'migrations'),
    ignoreFields: options.ignoreFields,
  });

  const passed = lint.passed && diff.failed === 0 && diff.total > 0;
  const summary = passed
    ? `PASS: 0 lint errors, ${diff.matched}/${diff.total} cases matched (100% parity).`
    : `FAIL: ${lint.errorCount} lint error(s), ${diff.failed}/${diff.total} parity mismatch(es).`;

  return {
    passed,
    lint,
    diff,
    summary,
  };
}
