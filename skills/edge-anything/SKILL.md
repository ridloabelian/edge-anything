---
name: edge-anything
description: Migrate any existing backend (Express, Fastify, Node HTTP, Next.js, FastAPI, Flask, Go, or Docker) to Cloudflare Workers/D1/KV/R2/Queues/Hyperdrive/Containers and prove 100% behavioral parity via recorded traffic replay.
---

# edge-anything Agent Skill

Use this workflow whenever asked to port, migrate, or verify an application for Cloudflare's edge platform.

## 5-Stage Parity Loop

1. **Scan** — Inspect architecture, routes, SQL DDLs, bindings, and V8 isolate blockers:
   ```bash
   npx edge-anything scan <source-dir> --json
   ```
   Or call MCP tool `edge_scan`.

2. **Record** — Capture a deterministic baseline HTTP corpus from the running legacy service before writing edge code:
   ```bash
   npx edge-anything record --url http://127.0.0.1:3000 --dir <source-dir> --out .edge-anything/corpus.json --json
   ```
   Use `--spec scenarios.json` whenever stateful create->read->update->delete flows exist.

3. **Port** — Generate `wrangler.jsonc`, `src/index.ts`, `src/env.d.ts`, `src/shims/*`, `migrations/0001_init.sql`, and `MIGRATION_PLAN.md`:
   ```bash
   npx edge-anything port <source-dir> --out <edge-dir> --json
   ```
   Then implement the business logic inside `<edge-dir>/src/index.ts` using the generated shims (`EdgeDB`, `EdgeKV`, `EdgeStorage`, `enqueueJob`).

4. **Lint** — Validate V8 isolate compliance (no global `Date.now()`/`Math.random()`/`fetch()`, no undeclared `env.*` bindings, no OS child processes):
   ```bash
   npx edge-anything lint <edge-dir> --json
   ```

5. **Diff & Gate** — Replay every recorded request against `<edge-dir>/src/index.ts` in the local edge simulator (D1 backed by `node:sqlite`, in-memory KV/R2/Queues) or against `wrangler dev`:
   ```bash
   npx edge-anything gate <edge-dir> --corpus .edge-anything/corpus.json --worker <edge-dir>/src/index.ts --json
   ```
   Do **not** declare the migration complete until `passed: true` (`0` lint errors and `0` parity mismatches).

## V8 Isolate Rules to Enforce
- Never mutate module-level `let` variables or `Map`/`Set` singletons across requests; use `env.CACHE` (KV), `env.DB` (D1), or Durable Objects (`env.STATE_DO`).
- Never call `fetch()`, `Date.now()`, `Math.random()`, `crypto.randomUUID()`, or `setTimeout()` at top-level module scope.
- Use `redirect: 'manual'` behavior faithfully on `301`/`302` responses and preserve `Content-Type` headers on R2 object downloads.
- For native C++ binaries or arbitrary Dockerfiles (`edgeReadinessScore` with blockers), route via a Hybrid Worker + Cloudflare Containers architecture rather than trying to polyfill OS syscalls.
