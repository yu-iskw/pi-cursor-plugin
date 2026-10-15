import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRecord, SkillRecord } from './catalog.js';

const MAX_DEPTH = 4;
const GENERAL_PURPOSE = 'generalPurpose';
const INHERITED_MODELS = new Set(['auto', 'inherit-parent']);
const MODEL_SLUG = /^[A-Za-z0-9_.:/@+-]+$/;
const READONLY_TOOLS = 'read,grep,find,ls';

const CLOUD_UNAVAILABLE =
  'Cursor cloud Task workers are not available in Pi. Respawn with environment "local". cloud_base_branch needs a cloud VM, which Pi does not provide.';
function isAlphanumeric(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9')
  );
}

function validSessionChar(char: string, edge: boolean): boolean {
  if (isAlphanumeric(char)) return true;
  return !edge && (char === '.' || char === '_' || char === '-');
}

function validSessionId(id: string): boolean {
  if (id.length < 1 || id.length > 128) return false;
  for (let index = 0; index < id.length; index += 1) {
    const edge = index === 0 || index === id.length - 1;
    if (!validSessionChar(id.charAt(index), edge)) return false;
  }
  return true;
}

export interface TaskRequest {
  prompt: string;
  description: string;
  subagentType: string;
  model?: string;
  readonly: boolean;
  cwd: string;
  depth: number;
  sessionId: string;
  sessionDir: string;
  resume: boolean;
  environment?: string;
  cloudBaseBranch?: string;
}

export interface SubagentLaunch {
  bin: string;
  args: string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type TaskPlan = { launch: SubagentLaunch } | { error: string };

export interface SubagentOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function inheritedModel(model: string | undefined): boolean {
  return model === undefined || model.trim() === '' || INHERITED_MODELS.has(model.trim());
}

function validateTask(request: TaskRequest): string | undefined {
  if (request.depth >= MAX_DEPTH) return `Subagent depth ${request.depth} exceeds ${MAX_DEPTH}.`;
  if (!request.prompt.trim()) return 'Task prompt is empty.';
  if (!request.subagentType.trim()) return 'subagent_type is empty.';
  const model = request.model?.trim();
  if (model && !INHERITED_MODELS.has(model) && (model.startsWith('-') || !MODEL_SLUG.test(model))) {
    return `Rejected model slug: ${model}`;
  }
  return undefined;
}

function resolveAgent(
  subagentType: string,
  agents: readonly AgentRecord[],
): { record?: AgentRecord; error?: string } {
  if (subagentType === GENERAL_PURPOSE) return {};
  const record = agents.find((agent) => agent.name === subagentType);
  if (record) return { record };
  const names = agents.map((agent) => agent.name);
  const available = ['generalPurpose', ...names].join(', ');
  return { error: `Unknown subagent_type ${subagentType}. Available: ${available}.` };
}

export function shouldBackground(requested: boolean | undefined, isBackground: boolean): boolean {
  return requested ?? isBackground;
}

export function findSession(sessionDir: string, id: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(sessionDir, name);
    const header = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
    try {
      const parsed: unknown = JSON.parse(header);
      if (parsed && typeof parsed === 'object' && Reflect.get(parsed, 'id') === id) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

function taskPrompt(
  request: TaskRequest,
  agent: AgentRecord | undefined,
  skills: readonly SkillRecord[],
): string {
  const poteto = skills.find((skill) => skill.directoryName === 'poteto-mode');
  const lines = [
    `You are the Cursor subagent "${request.subagentType}" running inside Pi.`,
    agent?.body ||
      'You are a general-purpose coding subagent. Complete the task and report the result to the parent.',
  ];
  if (poteto) {
    lines.push(
      `Parent-provided poteto-mode SKILL.md path: ${poteto.filePath}\nUse this absolute path. It is the path your parent gave you.`,
    );
  }
  lines.push(`Parent task (${request.description}):\n${request.prompt}`);
  return lines.join('\n\n');
}

function cloudError(request: TaskRequest): string | undefined {
  const branch = request.cloudBaseBranch?.trim();
  if (request.environment === 'cloud' || branch) return CLOUD_UNAVAILABLE;
  if (request.environment && request.environment !== 'local') {
    return `Rejected Task environment: ${request.environment}`;
  }
  return undefined;
}

function resumeError(request: TaskRequest): string | undefined {
  if (!request.resume) return undefined;
  if (!validSessionId(request.sessionId)) return `Rejected resume id: ${request.sessionId}`;
  if (!findSession(request.sessionDir, request.sessionId)) {
    return `No Pi session for agent ${request.sessionId}. Spawn a fresh subagent with the consolidated brief.`;
  }
  return undefined;
}

function launchArgs(request: TaskRequest): string[] {
  const args = ['--print', '--session-id', request.sessionId, '--session-dir', request.sessionDir];
  const model = request.model?.trim();
  if (model && !inheritedModel(model)) args.push('--model', model);
  if (request.readonly) args.push('--no-mcp', '--tools', READONLY_TOOLS);
  return args;
}

export function planTask(
  request: TaskRequest,
  agents: readonly AgentRecord[],
  skills: readonly SkillRecord[],
): TaskPlan {
  const invalid = validateTask(request) ?? cloudError(request) ?? resumeError(request);
  if (invalid) return { error: invalid };
  const resolved = resolveAgent(request.subagentType, agents);
  if (resolved.error) return { error: resolved.error };
  const depth = request.depth + 1;
  return {
    launch: {
      bin: process.env.PI_BIN?.trim() || 'pi',
      args: launchArgs(request),
      input: request.resume ? request.prompt : taskPrompt(request, resolved.record, skills),
      cwd: request.cwd,
      env: { ...process.env, PI_CURSOR_TASK_DEPTH: String(depth) },
    },
  };
}

export function currentTaskDepth(): number {
  const raw = process.env.PI_CURSOR_TASK_DEPTH;
  const depth = raw ? Number(raw) : 0;
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

export async function runSubagent(
  launch: SubagentLaunch,
  signal?: AbortSignal,
): Promise<SubagentOutput> {
  if (signal?.aborted) return { exitCode: null, stdout: '', stderr: 'Task aborted.' };
  return new Promise((resolve, reject) => {
    const child = spawn(launch.bin, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(launch.input);
  });
}

export function boundOutput(text: string, logPath: string): string {
  const limit = 16_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…truncated. Full output: ${logPath}`;
}
