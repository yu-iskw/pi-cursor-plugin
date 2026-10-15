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
