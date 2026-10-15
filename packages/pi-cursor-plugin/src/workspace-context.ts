import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { validSessionId } from './subagent.js';

export function projectSlug(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const slug = stripped.replaceAll('/', '-').replaceAll(':', '-');
  return slug.length > 0 ? slug : 'root';
}

function cursorProjectDir(cwd: string, homeDir = homedir()): string {
  return join(homeDir, '.cursor', 'projects', projectSlug(cwd));
}

export function agentTranscriptsDir(cwd: string, homeDir = homedir()): string {
  return join(cursorProjectDir(cwd, homeDir), 'agent-transcripts');
}

export function sessionIdentity(source: object): { id?: string; file?: string } {
  const manager: unknown = Reflect.get(source, 'sessionManager');
  if (!manager || typeof manager !== 'object') return {};
  const id = callString(manager, 'getSessionId');
  const file = callString(manager, 'getSessionFile');
  return { id, file };
}

function callString(target: object, method: string): string | undefined {
  const fn: unknown = Reflect.get(target, method);
  if (typeof fn !== 'function') return undefined;
  const value: unknown = Reflect.apply(fn, target, []);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function formatWorkspaceContext(input: {
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  parentTranscripts?: string;
}): string {
  const transcripts = transcriptDirectory(input);
  const store = dirname(transcripts);
  const lines = [
    '# Cursor workspace context',
    `Agent transcripts for this workspace live in ${transcripts}.`,
    'Use only that agent-transcripts directory. Do not search other projects under ~/.cursor/projects.',
    `The current agent's store is ${store}.`,
  ];
  if (input.sessionId && validSessionId(input.sessionId)) {
    lines.push(
      `This conversation's transcript is ${join(transcripts, input.sessionId, `${input.sessionId}.jsonl`)}.`,
    );
  }
  return lines.join('\n');
}

export function publishCursorTranscript(input: {
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  prompt?: string;
  homeDir?: string;
  parentTranscripts?: string;
  parentSessionId?: string;
}): string | undefined {
  if (!validSessionId(input.sessionId)) return undefined;
  const lines = withPrompt(linesFromSession(input.sessionFile), input.prompt);
  if (lines.length === 0) return undefined;
  const body = `${lines.join('\n')}\n`;
  const written = writeTranscript(transcriptDirectory(input), input.sessionId, body);
  if (input.parentTranscripts && input.parentSessionId) {
    writeSubagent(input.parentTranscripts, input.parentSessionId, input.sessionId, body);
  }
  return written;
}

function transcriptDirectory(input: {
  cwd: string;
  homeDir?: string;
  parentTranscripts?: string;
}): string {
  const parent = input.parentTranscripts?.trim();
  if (!parent) return agentTranscriptsDir(input.cwd, input.homeDir);
  return resolve(parent);
}

function linesFromSession(file: string | undefined): string[] {
  if (!file || !existsSync(file)) return [];
  const lines: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    const line = cursorLine(parseJson(raw));
    if (line) lines.push(line);
  }
  return lines;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function cursorLine(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  if (Reflect.get(entry, 'type') !== 'message') return undefined;
  const message: unknown = Reflect.get(entry, 'message');
  if (!message || typeof message !== 'object') return undefined;
  const role: unknown = Reflect.get(message, 'role');
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return undefined;
  const content: unknown = Reflect.get(message, 'content');
  const text = contentText(content);
  if (!text.trim()) return undefined;
  return JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => textFromBlock(block))
    .filter((part) => part.length > 0)
    .join('\n');
}

function textFromBlock(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const text: unknown = Reflect.get(block, 'text');
  if (typeof text === 'string' && text.trim()) return text;
  const name: unknown = Reflect.get(block, 'name');
  if (typeof name !== 'string' || name.length === 0) return '';
  const named: unknown = Reflect.get(block, 'arguments');
  const fallback: unknown = Reflect.get(block, 'input');
  const args = named ?? fallback;
  const rendered = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return `tool ${name} ${rendered}`;
}

function withPrompt(lines: string[], prompt: string | undefined): string[] {
  const text = prompt?.trim();
  if (!text || hasUserText(lines, text)) return lines;
  return [
    ...lines,
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } }),
  ];
}

function hasUserText(lines: readonly string[], text: string): boolean {
  for (const line of lines) {
    const parsed = parseJson(line);
    if (!parsed || typeof parsed !== 'object') continue;
    const role: unknown = Reflect.get(parsed, 'role');
    if (role !== 'user') continue;
    const message: unknown = Reflect.get(parsed, 'message');
    if (!message || typeof message !== 'object') continue;
    const content: unknown = Reflect.get(message, 'content');
    if (!Array.isArray(content)) continue;
    const first: unknown = content.at(0);
    if (first && typeof first === 'object' && Reflect.get(first, 'text') === text) return true;
  }
  return false;
}

function writeTranscript(directory: string, sessionId: string, body: string): string | undefined {
  const dir = join(directory, sessionId);
  const file = join(dir, `${sessionId}.jsonl`);
  if (!inside(directory, file)) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function writeSubagent(
  parentTranscripts: string,
  parentSessionId: string,
  sessionId: string,
  body: string,
): void {
  if (!validSessionId(parentSessionId)) return;
  const root = resolve(parentTranscripts);
  const dir = join(root, parentSessionId, 'subagents');
  const file = join(dir, `${sessionId}.jsonl`);
  if (!inside(root, file)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { mode: 0o600 });
}

function inside(root: string, target: string): boolean {
  const base = resolve(root);
  const file = resolve(target);
  return file === base || file.startsWith(`${base}${sep}`);
}
