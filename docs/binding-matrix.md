# Legacy-to-Cloudflare Binding Matrix

| Legacy Stack / Package / API | Cloudflare Primitive | Generated Binding | `wrangler.jsonc` Section | Strategy Notes |
| --- | --- | --- | --- | --- |
| `better-sqlite3`, `sqlite3`, `node:sqlite`, `@libsql/client` | **Cloudflare D1** | `env.DB` | `d1_databases` | Convert sync SQLite calls to `await env.DB.prepare(...).bind(...).all()/first()/run()`. |
| `pg`, `postgres`, `mysql2`, `prisma`, `drizzle-orm` | **Cloudflare Hyperdrive** | `env.HYPERDRIVE` | `hyperdrive` | Reuse existing Postgres/MySQL DB over pooled edge connections (`nodejs_compat` often required). |
| `redis`, `ioredis`, `node-cache`, `lru-cache`, TTL `Map` | **Cloudflare KV** | `env.CACHE` | `kv_namespaces` | Ideal for read-heavy caches with `expirationTtl`. Use D1/DO for strict atomic counters. |
| `@aws-sdk/client-s3`, `minio`, `multer`, local `fs` blob dirs | **Cloudflare R2** | `env.BUCKET` | `r2_buckets` | Store blobs/uploads with `httpMetadata.contentType` preserved. Zero egress fees. |
| `bullmq`, `bull`, `amqplib`, `celery` | **Cloudflare Queues** | `env.JOBS` | `queues.producers` | Move background jobs from in-process workers to async `queue()` batch consumers. |
| `ws`, `socket.io`, `yjs`, stateful room locks | **Durable Objects** | `env.STATE_DO` | `durable_objects.bindings` | Strongly consistent single-threaded coordination & hibernatable WebSockets. |
| `node-cron`, `cron`, `setInterval` cleanup loops | **Cron Triggers** | `scheduled()` | `triggers.crons` | Declarative cron schedules invoking Worker `scheduled(controller, env, ctx)`. |
| `openai`, `@anthropic-ai/sdk`, `@huggingface/inference` | **Workers AI / AI Gateway** | `env.AI` | `ai` | Optional edge inference or gateway caching/failover. |
| `Dockerfile`, `child_process`, `sharp`, `puppeteer`, Go servers | **Cloudflare Containers** | `env.APP_CONTAINER` | `containers` | Hybrid routing Worker at the edge delegating native/OS workloads to Containers. |
