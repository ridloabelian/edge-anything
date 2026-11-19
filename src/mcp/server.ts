import { createInterface } from 'node:readline';
import { executeMcpTool, MCP_TOOLS } from './tools.ts';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export async function handleMcpJsonRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
    return null;
  }

  try {
    switch (req.method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: 'edge-anything',
              version: '1.0.0',
            },
          },
        };
      }
      case 'ping': {
        return { jsonrpc: '2.0', id, result: {} };
      }
      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: MCP_TOOLS },
        };
      }
      case 'tools/call': {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        if (!name) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Missing tool name in tools/call params.' },
          };
        }
        const result = await executeMcpTool(name, args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          },
        };
      }
      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
      }
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function handleMcpHttpRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return Response.json({
      name: 'edge-anything',
      version: '1.0.0',
      transport: 'streamable-http',
      tools: MCP_TOOLS.map((t) => t.name),
    });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  let payload: JsonRpcRequest;
  try {
    payload = (await request.json()) as JsonRpcRequest;
  } catch {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON body' },
      },
      { status: 400 },
    );
  }

  const res = await handleMcpJsonRpc(payload);
  if (res === null) {
    return new Response(null, { status: 202 });
  }
  return Response.json(res, { status: 200 });
}

export async function startStdioMcpServer(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errOut: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON-RPC line' },
      };
      process.stdout.write(`${JSON.stringify(errOut)}\n`);
      continue;
    }

    const res = await handleMcpJsonRpc(parsed);
    if (res !== null) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  }
}
