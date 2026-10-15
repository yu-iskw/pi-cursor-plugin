export interface TaskRecord {
  id: string;
  description: string;
  status: 'running' | 'done' | 'error';
  output: string;
  deliveryError?: string;
}

interface TaskBoard {
  put(record: TaskRecord): void;
  update(id: string, patch: Partial<Omit<TaskRecord, 'id'>>): TaskRecord | undefined;
  get(id: string): TaskRecord | undefined;
  list(): TaskRecord[];
}

export function createTaskBoard(): TaskBoard {
  const records = new Map<string, TaskRecord>();
  return {
    put(record) {
      records.set(record.id, record);
    },
    update(id, patch) {
      const current = records.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      records.set(id, next);
      return next;
    },
    get(id) {
      return records.get(id);
    },
    list() {
      return [...records.values()];
    },
  };
}
