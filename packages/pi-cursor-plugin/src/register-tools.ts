import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Type } from 'typebox';

import { loadCatalog } from './catalog.js';
import { startCloudTask, wantsCloud } from './cloud-task.js';
import {
  applyTodos,
  formatAskWithoutUi,
  formatTodos,
  normalizeQuestions,
} from './cursor-actions.js';
import { storeRoot } from './manager.js';
import {
  boundOutput,
  currentTaskDepth,
  listInstalledModels,
  modelRejection,
  planTask,
  runSubagent,
  shouldBackground,
} from './subagent.js';
import { createTaskBoard } from './task-board.js';

import type { AgentRecord } from './catalog.js';
import type { AskQuestion, TodoItem } from './cursor-actions.js';
import type { SubagentLaunch, SubagentOutput } from './subagent.js';
import type { TaskRecord } from './task-board.js';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';

interface ToolDetails {
  kind: string;
  id?: string;
}

function textResult(
  text: string,
  details: ToolDetails,
  isError = false,
): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text }], details, isError };
}

function taskId(): string {
  return `task-${randomBytes(4).toString('hex')}`;
}

function resultText(result: SubagentOutput, logPath: string): { text: string; failed: boolean } {
  const combined = [result.stdout.trim(), result.stderr.trim()]
    .filter((part) => part.length > 0)
    .join('\n');
  const failed = result.exitCode !== 0;
  const body = combined || (failed ? `pi exited ${String(result.exitCode)}` : '(no output)');
  return { text: boundOutput(body, logPath), failed };
}

function writeLog(home: string, id: string, text: string): string {
  const directory = join(home, 'tasks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.log`);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

const ASK_OPTION = Type.Union([
  Type.String(),
  Type.Object({
    id: Type.Optional(Type.String()),
    label: Type.String(),
  }),
]);

const TODO_STATUS = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
]);

export function registerCursorTools(
  pi: ExtensionAPI,
  deliver: (message: string) => void,
  home = storeRoot(),
): void {
  const board = createTaskBoard();
  let todos: TodoItem[] = [];

  pi.registerTool({
    name: 'Task',
    label: 'Task',
    description:
      'Cursor Task tool. Spawn a pstack subagent (poteto-agent, comment-sicko, or generalPurpose) and return its report. Omit model or pass auto or inherit-parent to use the parent Pi model. environment "cloud" starts a Cursor cloud agent. resume continues that agent id.',
    promptSnippet: 'Spawn a Cursor-style subagent',
    promptGuidelines: [
      'Use the Task tool for pstack subagents. subagent_type poteto-agent, comment-sicko, or generalPurpose.',
      'Pass readonly true for read-only exploration. poteto-agent runs in the background unless run_in_background is false.',
      'Pass resume with an agent id only when the same checkout or process must continue. A missing session is an error.',
      'environment "cloud" starts a Cursor cloud agent when CURSOR_API_KEY and a GitHub origin are set. A rejected model slug includes the closest slugs of that family.',
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: 'Full task for the subagent' }),
      description: Type.String({ description: 'Short task label' }),
      subagent_type: Type.String({ description: 'poteto-agent, comment-sicko, or generalPurpose' }),
      model: Type.Optional(Type.String({ description: 'Model slug, auto, or inherit-parent' })),
      readonly: Type.Optional(Type.Boolean()),
      run_in_background: Type.Optional(Type.Boolean()),
      resume: Type.Optional(
        Type.String({ description: 'Agent id returned by an earlier Task call' }),
      ),
      environment: Type.Optional(
        Type.String({ description: 'local or cloud. cloud starts a Cursor cloud agent.' }),
      ),
      cloud_base_branch: Type.Optional(Type.String()),
    }),
    executionMode: 'parallel',
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<ToolDetails>> {
      return executeTask(params, signal, ctx, { home, board, deliver });
    },
  });

  pi.registerTool({
    name: 'task_output',
    label: 'Task output',
    description: 'Read the current output of a background task started by the task tool.',
    parameters: Type.Object({ task_id: Type.String() }),
    execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<ToolDetails>> {
      const record = board.get(params.task_id);
      if (!record) return Promise.reject(new Error(`Unknown task ${params.task_id}`));
      const delivery = record.deliveryError ? `\nDelivery error: ${record.deliveryError}` : '';
      return Promise.resolve(
        textResult(`${record.status} ${record.id}\n${record.output}${delivery}`, {
          kind: 'task-output',
          id: record.id,
        }),
      );
    },
  });

  pi.registerTool({
    name: 'AskQuestion',
    label: 'AskQuestion',
    description:
      'Cursor AskQuestion tool. Ask one question or several. Set allow_multiple to let the user pick more than one option. Options may be strings or { label } objects.',
    promptSnippet: 'Ask the user a multiple-choice question',
    parameters: Type.Object({
      question: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(ASK_OPTION)),
      allow_multiple: Type.Optional(Type.Boolean()),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            question: Type.String(),
            options: Type.Array(ASK_OPTION, { minItems: 1 }),
            allow_multiple: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<ToolDetails>> {
      const questions = normalizeQuestions(params);
      if (!ctx.hasUI) return textResult(formatAskWithoutUi(questions), { kind: 'ask' });
      const answers = await collectAnswers(ctx, questions);
      if (!answers) return textResult('The user dismissed the question.', { kind: 'ask' }, true);
      return textResult(JSON.stringify({ answers }), { kind: 'ask' });
    },
  });

  pi.registerTool({
    name: 'TodoWrite',
    label: 'TodoWrite',
    description: 'Cursor TodoWrite tool. Replace or merge the session todo list.',
    promptSnippet: 'Update the session todo list',
    parameters: Type.Object({
      merge: Type.Boolean(),
      todos: Type.Array(
        Type.Object({
          id: Type.String(),
          content: Type.String(),
          status: TODO_STATUS,
        }),
      ),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<ToolDetails>> {
      const incoming: TodoItem[] = params.todos.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
      }));
      todos = applyTodos(todos, { merge: params.merge, todos: incoming });
      return Promise.resolve(textResult(formatTodos(todos), { kind: 'todos' }));
    },
  });
}

interface TaskRuntime {
  home: string;
  board: ReturnType<typeof createTaskBoard>;
  deliver: (message: string) => void;
}

async function collectAnswers(
  ctx: ExtensionToolContext,
  questions: readonly AskQuestion[],
): Promise<{ question: string; selected: string[] }[] | undefined> {
  const answers: { question: string; selected: string[] }[] = [];
  for (const item of questions) {
    const selected = await selectOptions(ctx, item);
    if (!selected) return undefined;
    answers.push({ question: item.question, selected });
  }
  return answers;
}

async function selectOptions(
  ctx: ExtensionToolContext,
  item: AskQuestion,
): Promise<string[] | undefined> {
  if (!item.allowMultiple) {
    const choice = await ctx.ui.select(item.question, [...item.options]);
    return choice ? [choice] : undefined;
  }
  const raw = await ctx.ui.input(item.question, item.options.join(', '));
  if (!raw) return undefined;
  const selected = raw
    .split(',')
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  const unknown = selected.filter((option) => !item.options.includes(option));
  if (unknown.length > 0) throw new Error(`Unknown options: ${unknown.join(', ')}`);
  return selected;
}

async function executeTask(
  params: {
    prompt: string;
    description: string;
    subagent_type: string;
    model?: string;
    readonly?: boolean;
    run_in_background?: boolean;
    resume?: string;
    environment?: string;
    cloud_base_branch?: string;
  },
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  runtime: TaskRuntime,
): Promise<AgentToolResult<ToolDetails>> {
  const catalog = loadCatalog(runtime.home);
  const resume = params.resume?.trim() ?? '';
  if (
    params.environment === 'local' &&
    (params.cloud_base_branch?.trim() || resume.startsWith('bc-'))
  ) {
    throw new Error('cloud_base_branch and cloud agent ids apply to environment "cloud".');
  }
  if (wantsCloud(params.environment, params.cloud_base_branch, resume)) {
    return runCloud(params, catalog.agents, ctx.cwd, runtime);
  }
  const rejectedModel = modelRejection(params.model, await listInstalledModels(params.model));
  if (rejectedModel) throw new Error(rejectedModel);
  const id = resume || taskId();
  const agent = catalog.agents.find((entry) => entry.name === params.subagent_type);
  const plan = planTask(
    {
      prompt: params.prompt,
      description: params.description,
      subagentType: params.subagent_type,
      model: params.model,
      readonly: params.readonly === true,
      cwd: ctx.cwd,
      depth: currentTaskDepth(),
      sessionId: id,
      sessionDir: join(runtime.home, 'tasks', 'sessions'),
      resume: resume.length > 0,
      environment: params.environment,
      cloudBaseBranch: params.cloud_base_branch,
    },
    catalog.agents,
    catalog.skills,
  );
  if ('error' in plan) throw new Error(plan.error);
  if (shouldBackground(params.run_in_background, agent?.isBackground === true)) {
    startBackground(id, params.description, plan.launch, runtime);
    return textResult(
      `Started background agent ${id} (${params.description}). Resume this agent with Task resume set to ${id}. The result arrives as a follow-up. task_output can read it.`,
      { kind: 'task', id },
    );
  }
  return finishTask(id, params.description, plan.launch, signal, runtime.home);
}

async function runCloud(
  params: {
    prompt: string;
    description: string;
    subagent_type: string;
    model?: string;
    readonly?: boolean;
    run_in_background?: boolean;
    resume?: string;
    environment?: string;
    cloud_base_branch?: string;
  },
  agents: readonly AgentRecord[],
  cwd: string,
  runtime: TaskRuntime,
): Promise<AgentToolResult<ToolDetails>> {
  const resume = params.resume?.trim() ?? '';
  const agent = agents.find((entry) => entry.name === params.subagent_type);
  const started = await startCloudTask({
    prompt: params.prompt,
    model: params.model,
    readonly: params.readonly === true,
    cwd,
    environment: params.environment,
    baseBranch: params.cloud_base_branch,
    resumeId: resume.startsWith('bc-') ? resume : undefined,
  });
  const background = shouldBackground(params.run_in_background, agent?.isBackground === true);
  if (background) {
    runtime.board.put({
      id: started.agentId,
      description: params.description,
      status: 'running',
      output: '',
    });
    void started.done
      .then((result) => {
        const status = result.failed ? 'error' : 'done';
        runtime.board.update(started.agentId, { status, output: result.text });
        try {
          runtime.deliver(
            `Background ${status} ${started.agentId} (${params.description})\n\n${result.text}`,
          );
        } catch (error) {
          const deliveryError = error instanceof Error ? error.message : String(error);
          runtime.board.update(started.agentId, { deliveryError });
        }
      })
      .catch((error: unknown) => {
        const output = error instanceof Error ? error.message : String(error);
        runtime.board.update(started.agentId, { status: 'error', output });
      });
    return textResult(
      `Started background cloud agent ${started.agentId} (${params.description}). Resume this agent with Task resume set to ${started.agentId}.`,
      { kind: 'task', id: started.agentId },
    );
  }
  const result = await started.done;
  return textResult(
    `Agent id: ${started.agentId}\n${params.description}\n${result.text}`,
    { kind: 'task', id: started.agentId },
    result.failed,
  );
}

function startBackground(
  id: string,
  description: string,
  launch: SubagentLaunch,
  runtime: TaskRuntime,
): void {
  const record: TaskRecord = { id, description, status: 'running', output: '' };
  runtime.board.put(record);
  void runSubagent(launch)
    .then((result) => {
      const logPath = writeLog(runtime.home, id, `${result.stdout}\n${result.stderr}`);
      const rendered = resultText(result, logPath);
      const status = rendered.failed ? 'error' : 'done';
      runtime.board.update(id, { status, output: rendered.text });
      try {
        runtime.deliver(`Background ${status} ${id} (${description})\n\n${rendered.text}`);
      } catch (error) {
        const deliveryError = error instanceof Error ? error.message : String(error);
        runtime.board.update(id, { deliveryError });
      }
    })
    .catch((error: unknown) => {
      const output = error instanceof Error ? error.message : String(error);
      runtime.board.update(id, { status: 'error', output });
    });
}

async function finishTask(
  id: string,
  description: string,
  launch: SubagentLaunch,
  signal: AbortSignal | undefined,
  home: string,
): Promise<AgentToolResult<ToolDetails>> {
  try {
    const result = await runSubagent(launch, signal);
    const logPath = writeLog(home, id, `${result.stdout}\n${result.stderr}`);
    const rendered = resultText(result, logPath);
    return textResult(
      `Agent id: ${id}\n${description}\n${rendered.text}`,
      {
        kind: 'task',
        id,
      },
      rendered.failed,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot start ${launch.bin}: ${message}`, { cause: error });
  }
}
