# How `edge-anything` Works

`edge-anything` treats edge migration as a **deterministic verification problem**, not a blind code generation exercise. Every migration moves through five verifiable stages:

## 1. Static Architecture & Isolate Scan (`scan`)

`scanProject()` inspects the source repository without executing untrusted application code:
- Walks source files and manifests (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Dockerfile`).
- Extracts HTTP routes across Express, Fastify, Hono, Koa, Next.js App Router, raw `node:http`, FastAPI, Flask, and Go `net/http`.
- Captures SQL `CREATE TABLE` / `CREATE INDEX` DDL blocks.
- Maps stateful dependencies and code patterns to Cloudflare bindings (`D1`, `Hyperdrive`, `KV`, `R2`, `Queues`, `Durable Objects`, `Cron Triggers`, `Workers AI`, and `Containers`).
- Audits V8 isolate compatibility (`nodejs_compat` flags vs isolate blockers such as `child_process`, native C++ addons, or persistent local filesystem writes) to output an `edgeReadinessScore` and `recommendedStrategy`.

## 2. Behavioral Traffic Recording (`record`)

`recordTraffic()` captures ground-truth HTTP behavior from the legacy origin before edge changes begin:
- Uses either auto-discovered probes (`buildProbeSuite`) or ordered stateful scenarios (`--spec scenarios.json`).
- Replays requests with `redirect: 'manual'` so `301`/`302` `Location` headers are preserved rather than silently followed.
- Encodes binary payloads safely via base64 (`isBase64: true`) and computes a canonical SHA-256 corpus digest.

## 3. Edge Scaffold & Shim Synthesis (`port`)

`portProject()` generates an idiomatic Cloudflare Workers project:
- `wrangler.jsonc` with explicit bindings and conditional `compatibility_flags: ["nodejs_compat"]`.
- Typed `src/env.d.ts`, clean Web `fetch()` router stub in `src/index.ts`, and `scheduled()` / `queue()` handlers when needed.
- Zero-dependency shims in `src/shims/` (`EdgeDB`, `EdgeKV`, `EdgeStorage`, `enqueueJob`).
- SQL migrations in `migrations/0001_init.sql` and a structured `MIGRATION_PLAN.md`.

## 4. Isolate Linter & In-Process Edge Simulator (`lint` + `simulator`)

- `lintEdgeProject()` statically parses `wrangler.jsonc` and Worker sources to catch missing default exports, forbidden Node built-ins, undeclared `env.*` bindings, global-scope side effects (`Date.now()`, `Math.random()`, `fetch()`, `setTimeout()` at module top level), and mutable module-level state.
- `createWorkerSimulator()` instantiates an in-memory Cloudflare runtime directly inside Node.js 22+:
  - **D1** powered by Node's built-in `node:sqlite` (`DatabaseSync(':memory:')`), automatically executing `migrations/*.sql`.
  - **KV** powered by a TTL-aware in-memory namespace.
  - **R2** powered by an in-memory object store preserving `httpMetadata.contentType`, `etag`, and byte buffers.
  - **Queues** and `ExecutionContext.waitUntil()`.

## 5. Parity Diff & Release Gate (`diff` + `gate`)

`diffAgainstTarget()` replays every recorded case sequentially against either `--worker src/index.ts` (simulated) or `--url <edge-url>` (live `wrangler dev` / deployed Worker), performing:
- Exact HTTP status matching.
- Normalized `content-type` media-type, `location`, and CORS header assertions.
- Deep recursive JSON structural equality with configurable volatile field masking (`--ignore-fields timestamp,requestId` verifies masked keys still exist and match runtime type without false-failing on wall-clock timestamps).
- Exact UTF-8 / binary byte comparison for non-JSON payloads.

`runReleaseGate()` succeeds (`exit 0`) if and only if `lint.errorCount === 0` AND `diff.failed === 0`.

## What It Cannot Catch

Behavioral parity can only prove equivalence across scenarios exercised in the recorded corpus (`corpus.json`). Uncovered routes, background cron side effects without HTTP observables, or production-scale eventual consistency behaviors of global KV require targeted scenario specs and live `wrangler dev` / staging checks.
