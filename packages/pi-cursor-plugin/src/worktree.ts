import { spawn } from 'node:child_process';
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

export async function taskCwd(input: {
  parent: string;
  sessionDir: string;
  id: string;
  resume: boolean;
  stayInParent: boolean;
}): Promise<string> {
  if (input.resume) {
    // Agents started before checkout files existed stay in the parent directory.
    return rememberedCheckout(input.sessionDir, input.id) ?? input.parent;
  }
  if (input.stayInParent) return input.parent;
  return createTaskWorktree(input.parent, input.id);
}

export async function createTaskWorktree(repoCwd: string, taskId: string): Promise<string> {
  if (!validSessionId(taskId)) throw new Error(`Rejected resume id: ${taskId}`);
  const top = await runGit(['rev-parse', '--show-toplevel'], repoCwd);
  if (top.status !== 0 || !top.stdout.trim()) {
    throw new Error(`Cannot isolate Task ${taskId}: ${repoCwd} is not a git repository.`);
  }
  const root = top.stdout.trim();
  const parent = join(worktreeRoot(), basename(root));
  const destination = join(parent, taskId);
  mkdirSync(parent, { recursive: true });
  const added = await runGit(
    ['worktree', 'add', '-b', `pstack/${taskId}`, destination, 'HEAD'],
    root,
  );
  if (added.status !== 0) {
    throw new Error(`Cannot create a worktree for Task ${taskId}: ${added.stderr.trim()}`);
  }
  return destination;
}

function checkoutFile(sessionDir: string, id: string): string {
  if (!validSessionId(id)) throw new Error(`Rejected resume id: ${id}`);
  return join(sessionDir, `${id}.cwd`);
}

function runGit(
  args: string[],
  cwd: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (status: number, extra: string): void => {
      if (settled) return;
      settled = true;
      const stderr = Buffer.concat(err).toString('utf8').trim();
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stderr || extra,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on('error', (error) => {
      finish(1, error.message);
    });
    child.on('close', (status) => {
      finish(status ?? 1, '');
    });
  });
}
