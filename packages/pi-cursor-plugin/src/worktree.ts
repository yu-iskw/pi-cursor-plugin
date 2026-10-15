import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { validSessionId } from './subagent.js';

const writers = new Map<string, number>();

export function claimWriter(cwd: string): boolean {
  const current = writers.get(cwd) ?? 0;
  writers.set(cwd, current + 1);
  return current === 0;
}

export function releaseWriter(cwd: string): void {
  const current = writers.get(cwd) ?? 0;
  if (current <= 1) writers.delete(cwd);
  else writers.set(cwd, current - 1);
}

export function writerCount(cwd: string): number {
  return writers.get(cwd) ?? 0;
}

export function worktreeRoot(): string {
  return process.env.PI_CURSOR_WORKTREE_ROOT?.trim() || join(homedir(), '.cursor', 'worktrees');
}

export function rememberCheckout(sessionDir: string, id: string, cwd: string): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(checkoutFile(sessionDir, id), `${cwd}\n`, { mode: 0o600 });
}

export function rememberedCheckout(sessionDir: string, id: string): string | undefined {
  const file = checkoutFile(sessionDir, id);
  if (!existsSync(file)) return undefined;
  const value = readFileSync(file, 'utf8').trim();
  return value || undefined;
}

export function taskCwd(input: {
  parent: string;
  sessionDir: string;
  id: string;
  resume: boolean;
  readonly: boolean;
  inherited: boolean;
}): string {
  if (input.resume) return rememberedCheckout(input.sessionDir, input.id) ?? input.parent;
  if (input.readonly || input.inherited) return input.parent;
  return createTaskWorktree(input.parent, input.id);
}

export function createTaskWorktree(repoCwd: string, taskId: string): string {
  const top = runGit(['rev-parse', '--show-toplevel'], repoCwd);
  if (top.status !== 0 || !top.stdout.trim()) {
    throw new Error(`Cannot isolate Task ${taskId}: ${repoCwd} is not a git repository.`);
  }
  const root = top.stdout.trim();
  const destination = join(worktreeRoot(), basename(root), taskId);
  mkdirSync(join(worktreeRoot(), basename(root)), { recursive: true });
  const added = runGit(['worktree', 'add', '-b', `pstack/${taskId}`, destination, 'HEAD'], root);
  if (added.status !== 0) {
    throw new Error(`Cannot create a worktree for Task ${taskId}: ${added.stderr.trim()}`);
  }
  return destination;
}

function checkoutFile(sessionDir: string, id: string): string {
  if (!validSessionId(id)) throw new Error(`Rejected resume id: ${id}`);
  return join(sessionDir, `${id}.cwd`);
}

function runGit(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout,
    stderr: result.stderr.trim() || (result.error instanceof Error ? result.error.message : ''),
  };
}
