# AGENTS.md — `edge-anything`

Guidelines for coding agents working on `edge-anything`:

- **Zero Runtime Dependencies**: Keep `package.json` free of external runtime `dependencies` and `devDependencies`. Use built-in Node.js 22+ APIs (`node:fs/promises`, `node:http`, `node:sqlite`, `node:crypto`, `node:test`, Web `fetch`/`Request`/`Response`).
- **Node 22 Native TypeScript Compatibility**:
  - Always use `import type { ... }` for type-only imports (`verbatimModuleSyntax: true`).
  - Always include `.ts` extensions on relative imports.
  - Never use TypeScript `enum`, `namespace`, or parameter properties (`constructor(private x: string)`).
- **JSON Output Purity**: When `--json` is passed to CLI commands, write strictly valid JSON to `stdout`.
- **Verification**: Run `npm test` and `npm run benchmark` before committing any change.
