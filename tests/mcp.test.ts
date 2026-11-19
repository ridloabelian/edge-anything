import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleMcpHttpRequest, handleMcpJsonRpc } from '../src/mcp/server.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('MCP Dual-Mode Server', () => {
  it('handles initialize, tools/list, and tools/call (edge_binding_guide & edge_scan)', async () => {
    const init = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init?.id, 1);
    assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, 'edge-anything');

    const listRes = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (listRes?.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((t) => t.name === 'edge_scan'));
    assert.ok(tools.some((t) => t.name === 'edge_gate'));
    assert.equal(tools.length, 7);

    const guideRes = await handleMcpHttpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'edge_binding_guide', arguments: { kind: 'd1' } },
        }),
      }),
    );
    assert.equal(guideRes.status, 200);
    const guideJson = (await guideRes.json()) as {
      result: { structuredContent: { binding: string } };
    };
    assert.match(guideJson.result.structuredContent.binding, /D1Database/);

    const scanRes = await handleMcpHttpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'edge_scan',
            arguments: { dir: path.join(repoRoot, 'examples', 'legacy-node-api') },
          },
        }),
      }),
    );
    const scanJson = (await scanRes.json()) as {
      result: { structuredContent: { routes: unknown[]; bindings: Array<{ kind: string }> } };
    };
    assert.equal(scanJson.result.structuredContent.routes.length, 12);
    assert.ok(scanJson.result.structuredContent.bindings.some((b) => b.kind === 'd1'));
  });
});
