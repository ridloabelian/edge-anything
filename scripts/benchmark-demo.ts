import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLegacyServer } from '../examples/legacy-node-api/server.ts';
import { recordTraffic } from '../src/recorder/recorder.ts';
import { scanProject } from '../src/scanner/isolateAudit.ts';
import { runReleaseGate } from '../src/verifier/gate.ts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyDir = path.join(rootDir, 'examples', 'legacy-node-api');
const edgeDir = path.join(rootDir, 'examples', 'edge-worker-port');
const scenariosPath = path.join(legacyDir, 'scenarios.json');

const legacyHandle = await startLegacyServer(0);

try {
  const scan = await scanProject(legacyDir);
  const corpus = await recordTraffic({
    originUrl: legacyHandle.url,
    specPath: scenariosPath,
  });

  const gate = await runReleaseGate({
    targetDir: edgeDir,
    corpus,
    workerEntry: path.join(edgeDir, 'src', 'index.ts'),
    migrationsDir: path.join(edgeDir, 'migrations'),
  });

  const summary = {
    legacyFramework: scan.framework,
    routesDetected: scan.routes.length,
    bindingsInferred: scan.bindings.map((b) => `${b.kind}:${b.bindingName}`),
    readinessScore: scan.edgeReadinessScore,
    casesRecorded: corpus.cases.length,
    lintErrors: gate.lint.errorCount,
    lintWarnings: gate.lint.warningCount,
    bundleBytes: gate.lint.bundleBytes,
    parityMatched: `${gate.diff.matched}/${gate.diff.total}`,
    passRate: `${gate.diff.passRate}%`,
    originP50Ms: gate.diff.originP50Ms,
    originP95Ms: gate.diff.originP95Ms,
    edgeP50Ms: gate.diff.edgeP50Ms,
    edgeP95Ms: gate.diff.edgeP95Ms,
    speedupFactor: `${gate.diff.speedupFactor}x`,
    gatePassed: gate.passed,
  };

  process.stdout.write('=== edge-anything Benchmark & Parity Report ===\n');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!gate.passed) {
    process.stderr.write(`Gate failed: ${gate.summary}\n`);
    for (const f of gate.diff.results.filter((r) => !r.matched)) {
      process.stderr.write(`  [${f.id}] ${f.method} ${f.pathWithQuery}: ${f.mismatches.join('; ')}\n`);
    }
    process.exitCode = 1;
  }
} finally {
  await legacyHandle.close();
}
