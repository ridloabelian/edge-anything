import { readFile } from 'node:fs/promises';
import type { RecordedRequest, RouteDescriptor } from '../types.ts';

export interface ScenarioSpecItem {
  id?: string;
  label?: string;
  method?: string;
  path?: string;
  pathWithQuery?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function loadScenarioSpec(specPath: string): Promise<RecordedRequest[]> {
  const raw = await readFile(specPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown[] }).cases)
      ? (parsed as { cases: unknown[] }).cases
      : [];

  return list.map((entry, idx) => {
    const item = entry as ScenarioSpecItem;
    const method = (item.method ?? 'GET').toUpperCase();
    const pathWithQuery = item.pathWithQuery ?? item.path ?? '/';
    const headers: Record<string, string> = {};
    if (item.headers) {
      for (const [k, v] of Object.entries(item.headers)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    let body: string | undefined;
    if (item.body !== undefined) {
      if (typeof item.body === 'string') {
        body = item.body;
      } else {
        body = JSON.stringify(item.body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
      }
    }
    return {
      id: item.id ?? `case_${String(idx + 1).padStart(3, '0')}`,
      label: item.label ?? `${method} ${pathWithQuery}`,
      method,
      pathWithQuery,
      headers,
      ...(body !== undefined ? { body } : {}),
    };
  });
}

function materializeRoutePath(routePath: string): string {
  return routePath
    .replace(/:([a-zA-Z0-9_]+)/g, (_m, name: string) => {
      if (name.toLowerCase().includes('code')) return 'demo-code';
      if (name.toLowerCase().includes('key')) return 'sample.txt';
      return '1';
    })
    .replace(/\*$/, 'sample');
}

export function buildProbeSuite(routes: RouteDescriptor[]): RecordedRequest[] {
  const probes: RecordedRequest[] = [];
  let seq = 1;
  const nextId = (): string => `probe_${String(seq++).padStart(3, '0')}`;

  if (routes.length === 0) {
    probes.push({
      id: nextId(),
      label: 'GET /',
      method: 'GET',
      pathWithQuery: '/',
      headers: {},
    });
  } else {
    for (const route of routes) {
      const concretePath = materializeRoutePath(route.path);
      const method = route.method.toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        probes.push({
          id: nextId(),
          label: `${method} ${concretePath} (unicode payload)`,
          method,
          pathWithQuery: concretePath,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'Edge Probe',
            content: 'Halo Dunia 🚀',
            tags: ['edge', 'parity'],
          }),
        });
      } else {
        probes.push({
          id: nextId(),
          label: `${method} ${concretePath}`,
          method,
          pathWithQuery: concretePath,
          headers: {},
        });
      }
    }
  }

  const firstGet = routes.find((r) => r.method.toUpperCase() === 'GET' && !r.path.includes(':'));
  if (firstGet) {
    const sep = firstGet.path.includes('?') ? '&' : '?';
    probes.push({
      id: nextId(),
      label: `GET ${firstGet.path} (query encoding)`,
      method: 'GET',
      pathWithQuery: `${firstGet.path}${sep}q=hello%20edge&limit=5`,
      headers: {},
    });
  }

  const firstPost = routes.find((r) => r.method.toUpperCase() === 'POST');
  if (firstPost) {
    const concrete = materializeRoutePath(firstPost.path);
    probes.push({
      id: nextId(),
      label: `POST ${concrete} (malformed JSON 400 trap)`,
      method: 'POST',
      pathWithQuery: concrete,
      headers: { 'content-type': 'application/json' },
      body: '{"broken_json": ',
    });
  }

  probes.push({
    id: nextId(),
    label: 'OPTIONS CORS preflight',
    method: 'OPTIONS',
    pathWithQuery: routes[0] ? materializeRoutePath(routes[0].path) : '/',
    headers: {
      origin: 'https://example.com',
      'access-control-request-method': 'POST',
    },
  });

  probes.push({
    id: nextId(),
    label: 'GET unknown route 404 check',
    method: 'GET',
    pathWithQuery: '/__edge_anything_missing_route__',
    headers: {},
  });

  return probes;
}
