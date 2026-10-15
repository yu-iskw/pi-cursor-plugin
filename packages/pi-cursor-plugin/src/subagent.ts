import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRecord, SkillRecord } from './catalog.js';

const MAX_DEPTH = 4;
const GENERAL_PURPOSE = 'generalPurpose';
const INHERITED_MODELS = new Set(['auto', 'inherit-parent']);
const MODEL_SLUG = /^[A-Za-z0-9_.:/@+-]+$/;
const READONLY_TOOLS = 'read,grep,find,ls';

const CLOUD_HANDOFF = 'Cloud Task requests are handled by the Cursor cloud runtime.';
const EFFORT_TOKENS = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'fast']);
function isAlphanumeric(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9')
  );
}

function validSessionChar(char: string, edge: boolean): boolean {
  if (isAlphanumeric(char)) return true;
  return !edge && (char === '.' || char === '_' || char === '-');
}

export function validSessionId(id: string): boolean {
  if (id.length < 1 || id.length > 128) return false;
  for (let index = 0; index < id.length; index += 1) {
    const edge = index === 0 || index === id.length - 1;
    if (!validSessionChar(id.charAt(index), edge)) return false;
  }
  return true;
}

interface TaskRequest {
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
  parentModel?: string;
}

export interface SubagentLaunch {
  bin: string;
  args: string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type TaskPlan = { launch: SubagentLaunch } | { error: string };

export interface SubagentOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function inheritedModel(model: string | undefined): boolean {
  return model === undefined || model.trim() === '' || INHERITED_MODELS.has(model.trim());
}

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function parentModelArg(
  model: { id: string; provider?: string } | undefined,
  thinkingLevel?: string,
): string | undefined {
  const id = model?.id.trim();
  if (!id) return undefined;
  const provider = model?.provider?.trim();
  const slug = provider ? `${provider}/${id}` : id;
  if (!thinkingLevel || !THINKING_LEVELS.has(thinkingLevel)) return slug;
  return `${slug}:${thinkingLevel}`;
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

export function taskGate(input: {
  depth: number;
  prompt: string;
  subagentType: string;
  model?: string;
  agents: readonly AgentRecord[];
}): string | undefined {
  if (input.depth >= MAX_DEPTH) return `Subagent depth ${input.depth} exceeds ${MAX_DEPTH}.`;
  if (!input.prompt.trim()) return 'Task prompt is empty.';
  if (!input.subagentType.trim()) return 'subagent_type is empty.';
  const model = input.model?.trim();
  if (model && !INHERITED_MODELS.has(model) && (model.startsWith('-') || !MODEL_SLUG.test(model))) {
    return `Rejected model slug: ${model}`;
  }
  return resolveAgent(input.subagentType, input.agents).error;
}

export function formatSubagentPrompt(
  request: Pick<TaskRequest, 'subagentType' | 'description' | 'prompt' | 'cwd'>,
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
  lines.push(`Working directory: ${request.cwd}`);
  lines.push(`Parent task (${request.description}):\n${request.prompt}`);
  return lines.join('\n\n');
}

const PSTACK_FAMILIES: readonly { name: string; prefixes: readonly string[] }[] = [
  { name: 'claude', prefixes: ['claude-'] },
  { name: 'grok', prefixes: ['cursor-grok-', 'composer-', 'grok-'] },
];

export function modelFamily(slug: string): string {
  for (const family of PSTACK_FAMILIES) {
    if (family.prefixes.some((prefix) => slug.startsWith(prefix))) return family.name;
  }
  const parts = slug.split('-');
  while (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (!tail || !EFFORT_TOKENS.has(tail)) break;
    parts.pop();
  }
  return parts.join('-');
}

export function suggestModels(slug: string, available: readonly string[]): string[] {
  const family = modelFamily(slug);
  return available.filter((item) => item !== slug && modelFamily(item) === family);
}

export function rejectedModelMessage(slug: string, available: readonly string[]): string {
  const suggestions = suggestModels(slug, available);
  const listed = suggestions.length > 0 ? suggestions.join(', ') : 'none';
  return `Rejected model slug: ${slug}. Closest ${modelFamily(slug)}: ${listed}.`;
}

export function parseModelList(text: string): string[] {
  if (text.includes('No models available')) return [];
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s{2,}/);
    const cell = columns.length >= 2 ? columns[1] : columns[0];
    const token = cell.trim();
    if (!token || token === 'model') continue;
    const slug = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token;
    if (MODEL_SLUG.test(slug) && !found.includes(slug)) found.push(slug);
  }
  return found;
}

function concreteModel(slug: string | undefined): string | undefined {
  const value = slug?.trim();
  if (!value || INHERITED_MODELS.has(value)) return undefined;
  if (value.startsWith('-') || !MODEL_SLUG.test(value)) return undefined;
  return value;
}

export function modelRejection(
  slug: string | undefined,
  available: readonly string[],
): string | undefined {
  const value = concreteModel(slug);
  if (!value || available.length === 0 || available.includes(value)) return undefined;
  return rejectedModelMessage(value, available);
}

let cachedModels: readonly string[] | undefined;

export function listInstalledModels(slug: string | undefined): Promise<readonly string[]> {
  if (!concreteModel(slug)) return Promise.resolve([]);
  if (cachedModels && cachedModels.length > 0) return Promise.resolve(cachedModels);
  return readPiModels();
}

function readPiModels(): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const child = spawn('pi', ['--list-models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 15000);
    const finish = (models: readonly string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (models.length > 0) cachedModels = models;
      resolve(models);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    child.on('error', () => {
      finish([]);
    });
    child.on('close', () => {
      finish(parseModelList(text));
    });
  });
}

function cloudError(request: TaskRequest): string | undefined {
  const branch = request.cloudBaseBranch?.trim();
  if (request.environment === 'cloud' || branch) return CLOUD_HANDOFF;
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
  const requested = request.model?.trim();
  const model = requested && !inheritedModel(requested) ? requested : request.parentModel?.trim();
  if (model) args.push('--model', model);
  if (request.readonly) args.push('--no-mcp', '--tools', READONLY_TOOLS);
  return args;
}

export function planTask(
  request: TaskRequest,
  agents: readonly AgentRecord[],
  skills: readonly SkillRecord[],
): TaskPlan {
  const invalid =
    taskGate({
      depth: request.depth,
      prompt: request.prompt,
      subagentType: request.subagentType,
      model: request.model,
      agents,
    }) ??
    cloudError(request) ??
    resumeError(request);
  if (invalid) return { error: invalid };
  const resolved = resolveAgent(request.subagentType, agents);
  if (resolved.error) return { error: resolved.error };
  const depth = request.depth + 1;
  return {
    launch: {
      bin: process.env.PI_BIN?.trim() || 'pi',
      args: launchArgs(request),
      input: request.resume
        ? request.prompt
        : formatSubagentPrompt(request, resolved.record, skills),
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
