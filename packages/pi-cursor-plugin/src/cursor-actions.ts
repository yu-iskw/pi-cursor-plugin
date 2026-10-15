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

interface AskOption {
  id?: string;
  label: string;
}

interface AskQuestionInput {
  question?: string;
  options?: readonly (string | AskOption)[];
  allow_multiple?: boolean;
  questions?: readonly {
    question: string;
    options: readonly (string | AskOption)[];
    allow_multiple?: boolean;
  }[];
}

export interface AskQuestion {
  question: string;
  options: readonly string[];
  allowMultiple: boolean;
}

function optionLabel(option: string | AskOption): string {
  return typeof option === 'string' ? option : option.label;
}

export function normalizeQuestions(input: AskQuestionInput): AskQuestion[] {
  const source =
    input.questions && input.questions.length > 0
      ? input.questions
      : input.question && input.options
        ? [
            {
              question: input.question,
              options: input.options,
              allow_multiple: input.allow_multiple,
            },
          ]
        : undefined;
  if (!source) throw new Error('AskQuestion needs a question and options, or a questions array.');
  return source.map((item) => ({
    question: item.question,
    options: item.options.map(optionLabel),
    allowMultiple: item.allow_multiple === true,
  }));
}

export function formatAskWithoutUi(questions: readonly AskQuestion[]): string {
  const blocks = questions.map((item) => {
    const mode = item.allowMultiple ? 'Select one or more.' : 'Select one.';
    const choices = item.options.map((option) => `- ${option}`).join('\n');
    return `${mode}\nQuestion: ${item.question}\nOptions:\n${choices}`;
  });
  return `No dialog is available. Ask the user in the conversation.\n${blocks.join('\n\n')}`;
}
