import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { validSessionId } from './subagent.js';
import { projectSlug } from './workspace-context.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export function applyTodos(
  current: readonly TodoItem[],
  update: { merge: boolean; todos: readonly TodoItem[] },
): TodoItem[] {
  if (!update.merge) return [...update.todos];
  const next = new Map(current.map((item) => [item.id, { ...item }]));
  for (const todo of update.todos) next.set(todo.id, { ...todo });
  return [...next.values()];
}

function statusMark(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return ' ';
    case 'in_progress':
      return '~';
    case 'completed':
      return 'x';
    case 'cancelled':
      return '-';
    default: {
      const unexpected: never = status;
      return unexpected;
    }
  }
}

export function formatTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'No todos.';
  return todos
    .map((todo) => `- [${statusMark(todo.status)}] ${todo.id}: ${todo.content}`)
    .join('\n');
}

export const TODO_WIDGET = 'pi-cursor-plugin-todos';

export function formatTodoMessage(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return '';
  return `# Session todos\n\n${formatTodos(todos)}`;
}

export function sessionTodoFile(
  cwd: string,
  sessionId: string,
  homeDir = homedir(),
): string | undefined {
  if (!validSessionId(sessionId)) return undefined;
  return join(homeDir, '.cursor', 'projects', projectSlug(cwd), 'todos', `${sessionId}.json`);
}

export function readSessionTodos(file: string | undefined): TodoItem[] {
  if (!file || !existsSync(file)) return [];
  return parseTodos(readFileSync(file, 'utf8'));
}

export function writeSessionTodos(file: string, todos: readonly TodoItem[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(todos)}\n`, { mode: 0o600 });
}

function parseTodos(raw: string): TodoItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: TodoItem[] = [];
  for (const entry of parsed) {
    const item = todoItem(entry);
    if (item) items.push(item);
  }
  return items;
}

function todoItem(entry: unknown): TodoItem | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const id: unknown = Reflect.get(entry, 'id');
  const content: unknown = Reflect.get(entry, 'content');
  const status: unknown = Reflect.get(entry, 'status');
  if (typeof id !== 'string' || typeof content !== 'string' || !isTodoStatus(status))
    return undefined;
  return { id, content, status };
}

function isTodoStatus(status: unknown): status is TodoStatus {
  switch (status) {
    case 'pending':
    case 'in_progress':
    case 'completed':
    case 'cancelled':
      return true;
    default:
      return false;
  }
}

interface AskOption {
  id?: string;
  label: string;
}

interface AskItemInput {
  id?: string;
  prompt?: string;
  question?: string;
  options?: readonly (string | AskOption)[];
  allow_multiple?: boolean;
}

interface AskQuestionInput extends AskItemInput {
  title?: string;
  questions?: readonly AskItemInput[];
}

export interface AskChoice {
  id?: string;
  label: string;
}

export interface AskQuestion {
  question: string;
  options: readonly AskChoice[];
  allowMultiple: boolean;
}

function askedText(item: AskItemInput): string {
  const prompt = item.prompt?.trim() ?? '';
  if (prompt.length > 0) return prompt;
  return item.question?.trim() ?? '';
}

function choiceFrom(option: string | AskOption): AskChoice {
  if (typeof option === 'string') return { label: option };
  const label = option.label.trim();
  const id = option.id?.trim();
  return id ? { id, label } : { label };
}

function withTitle(title: string | undefined, question: string, first: boolean): string {
  const heading = title?.trim();
  if (!first || !heading) return question;
  return `${heading}: ${question}`;
}

export function normalizeQuestions(input: AskQuestionInput): AskQuestion[] {
  const source =
    input.questions && input.questions.length > 0
      ? input.questions
      : askedText(input) && input.options
        ? [input]
        : undefined;
  if (!source) throw new Error('AskQuestion needs a prompt and options, or a questions array.');
  return source.map((item, index) => {
    const question = askedText(item);
    const options = item.options ?? [];
    if (!question || options.length === 0) {
      throw new Error('AskQuestion needs a prompt and options, or a questions array.');
    }
    return {
      question: withTitle(input.title, question, index === 0),
      options: options.map(choiceFrom),
      allowMultiple: item.allow_multiple === true,
    };
  });
}

export function formatAskWithoutUi(questions: readonly AskQuestion[]): string {
  const blocks = questions.map((item) => {
    const mode = item.allowMultiple ? 'Select one or more.' : 'Select one.';
    const choices = item.options.map((option) => `- ${option.label}`).join('\n');
    return `${mode}\nQuestion: ${item.question}\nOptions:\n${choices}`;
  });
  return `No dialog is available. Ask the user in the conversation.\n${blocks.join('\n\n')}`;
}
