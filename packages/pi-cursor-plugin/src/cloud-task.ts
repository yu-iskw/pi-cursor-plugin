import { spawnSync } from 'node:child_process';

import { Agent, Cursor, CursorAgentError } from '@cursor/sdk';

import { rejectedModelMessage } from './subagent.js';

export interface CloudTaskInput {
  prompt: string;
  model?: string;
  readonly: boolean;
  cwd: string;
  environment?: string;
  baseBranch?: string;
  resumeId?: string;
}

export interface CloudTaskStart {
  agentId: string;
  done: Promise<{ text: string; failed: boolean }>;
}

export function githubRepoUrl(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/, '');
  if (value.startsWith('git@github.com:')) {
    const repo = value.slice('git@github.com:'.length);
    return repo.includes('/') ? `https://github.com/${repo}` : undefined;
  }
  const prefix = 'https://github.com/';
  if (!value.startsWith(prefix)) return undefined;
  const [owner, name] = value.slice(prefix.length).split('/');
  if (!owner || !name) return undefined;
  return `https://github.com/${owner}/${name}`;
}

export function wantsCloud(
  environment: string | undefined,
  baseBranch: string | undefined,
  resumeId: string,
): boolean {
  if (environment === 'local') return false;
  return environment === 'cloud' || Boolean(baseBranch?.trim()) || resumeId.startsWith('bc-');
}

export function cloudReadiness(input: {
  apiKey: string | undefined;
  repoUrl: string | undefined;
  environment?: string;
  baseBranch?: string;
  resumeId?: string;
}): string | undefined {
  const branch = input.baseBranch?.trim();
  const cloud =
    input.environment === 'cloud' || Boolean(branch) || Boolean(input.resumeId?.startsWith('bc-'));
  if (!cloud) return undefined;
  if (input.environment === 'local') {
    return 'cloud_base_branch and cloud agent ids apply to environment "cloud".';
  }
  if (input.environment && input.environment !== 'cloud') {
    return `Rejected Task environment: ${input.environment}`;
  }
  if (!input.apiKey?.trim()) {
    return 'Cursor cloud Task needs CURSOR_API_KEY. Set it and retry, or respawn with environment "local".';
  }
  if (!input.repoUrl) {
    return 'Cursor cloud Task needs a GitHub origin remote. Respawn with environment "local" when the work is only on this machine.';
  }
  return undefined;
}

function gitOutput(args: string[], cwd: string): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) return undefined;
  const text = result.stdout.trim();
  return text || undefined;
}

function originRepo(cwd: string): string | undefined {
  const remote = gitOutput(['remote', 'get-url', 'origin'], cwd);
  return remote ? githubRepoUrl(remote) : undefined;
}

function startingRef(cwd: string, baseBranch: string | undefined): string | undefined {
  const requested = baseBranch?.trim();
  if (requested) return requested;
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch || branch === 'HEAD') return undefined;
  return branch;
}

function brief(input: CloudTaskInput): string {
  if (!input.readonly) return input.prompt;
  return `You are read-only. Do not edit files, commit, or open a pull request.\n\n${input.prompt}`;
}

function cloudModel(model: string | undefined): { id: string } | undefined {
  const value = model?.trim();
  if (!value || value === 'auto' || value === 'inherit-parent') return undefined;
  return { id: value };
}

async function modelHint(slug: string | undefined, apiKey: string, error: unknown): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  const value = slug?.trim();
  if (!value || value === 'auto' || value === 'inherit-parent') {
    return new Error(`Cursor cloud Task failed to start: ${message}`, { cause: error });
  }
  try {
    const models = await Cursor.models.list({ apiKey });
    const hint = rejectedModelMessage(
      value,
      models.map((item) => item.id),
    );
    return new Error(`${hint} ${message}`, { cause: error });
  } catch {
    return new Error(`Cursor cloud Task failed to start: ${message}`, { cause: error });
  }
}

function resultText(
  status: string,
  text: string | undefined,
  error: string | undefined,
): {
  text: string;
  failed: boolean;
} {
  const body = text?.trim() || error || `(cloud run ${status})`;
  return { text: body, failed: status !== 'finished' };
}

export async function startCloudTask(input: CloudTaskInput): Promise<CloudTaskStart> {
  if (input.environment === 'local') {
    throw new Error('cloud_base_branch and cloud agent ids apply to environment "cloud".');
  }
  if (input.environment && input.environment !== 'cloud') {
    throw new Error(`Rejected Task environment: ${input.environment}`);
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  const repoUrl = originRepo(input.cwd);
  const blocked = cloudReadiness({
    apiKey,
    repoUrl,
    environment: 'cloud',
    baseBranch: input.baseBranch,
    resumeId: input.resumeId,
  });
  if (blocked) throw new Error(blocked);
  if (!apiKey || !repoUrl)
    throw new Error('Cursor cloud Task is missing its API key or repository.');
  const options = {
    apiKey,
    model: cloudModel(input.model),
    cloud: {
      repos: [{ url: repoUrl, startingRef: startingRef(input.cwd, input.baseBranch) }],
      autoCreatePR: !input.readonly,
      skipReviewerRequest: true,
    },
  };
  try {
    const agent = input.resumeId
      ? await Agent.resume(input.resumeId, options)
      : await Agent.create(options);
    const run = await agent.send(brief(input));
    const done = (async () => {
      try {
        const result = await run.wait();
        return resultText(result.status, result.result, result.error?.message);
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    })();
    return { agentId: agent.agentId, done };
  } catch (error) {
    if (error instanceof CursorAgentError) throw await modelHint(input.model, apiKey, error);
    throw error;
  }
}
