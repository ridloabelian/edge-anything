export type SourceFramework =
  | 'express'
  | 'fastify'
  | 'hono'
  | 'koa'
  | 'nextjs'
  | 'nestjs'
  | 'node-http'
  | 'fastapi'
  | 'flask'
  | 'go-http'
  | 'dockerfile'
  | 'unknown';

export type CloudflareBindingKind =
  | 'd1'
  | 'hyperdrive'
  | 'kv'
  | 'r2'
  | 'queues'
  | 'durable_objects'
  | 'cron'
  | 'containers'
  | 'workers_ai';

export type TargetStrategy =
  | 'workers-native'
  | 'workers-nodejs-compat'
  | 'workers-hybrid-containers';

export interface RouteDescriptor {
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface BindingRecommendation {
  kind: CloudflareBindingKind;
  bindingName: string;
  sourcePackageOrApi: string;
  evidence: string[];
  confidence: 'high' | 'medium';
  rationale: string;
}

export interface IsolateIssue {
  severity: 'blocker' | 'warning' | 'compat';
  code: string;
  file: string;
  line: number;
  symbol: string;
  message: string;
  remediation: string;
}

export interface ScanReport {
  rootDir: string;
  scannedAt: string;
  language: string;
  framework: SourceFramework;
  filesScanned: number;
  routes: RouteDescriptor[];
  sqlSchemas: string[];
  bindings: BindingRecommendation[];
  isolateIssues: IsolateIssue[];
  requiresNodejsCompat: boolean;
  requiresContainers: boolean;
  edgeReadinessScore: number;
  recommendedStrategy: TargetStrategy;
}

export interface RecordedRequest {
  id: string;
  label: string;
  method: string;
  pathWithQuery: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isBase64?: boolean;
  durationMs: number;
}

export interface RecordedCase {
  request: RecordedRequest;
  response: RecordedResponse;
}

export interface ReplayCorpus {
  version: '1.0';
  createdAt: string;
  originUrl: string;
  sha256: string;
  cases: RecordedCase[];
}

export interface LintFinding {
  severity: 'error' | 'warning';
  rule: string;
  file: string;
  line: number;
  message: string;
  fixHint: string;
}

export interface LintReport {
  targetDir: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  declaredBindings: string[];
  referencedBindings: string[];
  bundleBytes: number;
  findings: LintFinding[];
}

export interface CaseDiff {
  id: string;
  method: string;
  pathWithQuery: string;
  matched: boolean;
  expectedStatus: number;
  actualStatus: number;
  originMs: number;
  edgeMs: number;
  mismatches: string[];
}

export interface DiffReport {
  total: number;
  matched: number;
  failed: number;
  passRate: number;
  originP50Ms: number;
  originP95Ms: number;
  edgeP50Ms: number;
  edgeP95Ms: number;
  speedupFactor: number;
  results: CaseDiff[];
}

export interface GateReport {
  passed: boolean;
  lint: LintReport;
  diff: DiffReport;
  summary: string;
}

export interface PortResult {
  sourceDir: string;
  outDir: string;
  strategy: TargetStrategy;
  filesWritten: string[];
  bindings: BindingRecommendation[];
  routesStubbed: number;
  migrationsGenerated: number;
}

export interface SourceFileEntry {
  absPath: string;
  relPath: string;
  ext: string;
  content: string;
}

export interface ParsedManifests {
  packageJson: Record<string, unknown> | null;
  dependencies: Record<string, string>;
  pythonPackages: string[];
  goModules: string[];
  hasDockerfile: boolean;
  dockerfileContent: string;
}
