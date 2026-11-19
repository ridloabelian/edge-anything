import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AgentTarget = 'claude' | 'codex' | 'antigravity' | 'cursor' | 'all';

export interface SkillInstallResult {
  agent: AgentTarget;
  dryRun: boolean;
  sourceSkillPath: string;
  installedPaths: string[];
}

function resolveAgentDirectories(agent: AgentTarget, customDir?: string): string[] {
  if (customDir) {
    return [path.resolve(customDir, 'edge-anything')];
  }
  const home = os.homedir();
  const map: Record<Exclude<AgentTarget, 'all'>, string> = {
    claude: path.join(home, '.claude', 'skills', 'edge-anything'),
    codex: path.join(home, '.codex', 'skills', 'edge-anything'),
    antigravity: path.join(home, '.gemini', 'config', 'skills', 'edge-anything'),
    cursor: path.join(home, '.cursor', 'skills', 'edge-anything'),
  };
  if (agent === 'all') {
    return Object.values(map);
  }
  return [map[agent]];
}

export async function installSkill(options: {
  agent?: AgentTarget;
  dir?: string;
  dryRun?: boolean;
}): Promise<SkillInstallResult> {
  const agent = options.agent ?? 'claude';
  const dryRun = Boolean(options.dryRun);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const sourceSkillPath = path.join(packageRoot, 'skills', 'edge-anything', 'SKILL.md');
  const content = await readFile(sourceSkillPath, 'utf8');
  const targets = resolveAgentDirectories(agent, options.dir);
  const installedPaths: string[] = [];

  for (const targetDir of targets) {
    const destFile = path.join(targetDir, 'SKILL.md');
    if (!dryRun) {
      await mkdir(targetDir, { recursive: true });
      await writeFile(destFile, content, 'utf8');
    }
    installedPaths.push(destFile);
  }

  return {
    agent,
    dryRun,
    sourceSkillPath,
    installedPaths,
  };
}
