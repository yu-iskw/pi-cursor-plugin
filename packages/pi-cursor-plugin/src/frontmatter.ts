type FrontmatterValue = string | boolean | string[];

interface Frontmatter {
  data: Map<string, FrontmatterValue>;
  body: string;
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (!quoted || value.length < 2) return value;
  const quote = value.charAt(0);
  return value.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\');
}

function parseScalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0);
  }
  return unquote(value);
}

const BLOCK_MARKERS = new Set(['>', '>-', '|', '|-']);

function lineAt(lines: readonly string[], index: number): string {
  return lines.at(index) ?? '';
}

function readBlock(
  lines: readonly string[],
  start: number,
  marker: string,
): { value: string; next: number } {
  const collected: string[] = [];
  let index = start;
  while (index + 1 < lines.length && /^\s+\S/.test(lineAt(lines, index + 1))) {
    index += 1;
    collected.push(lineAt(lines, index).trim());
  }
  const value = marker.startsWith('>') ? collected.join(' ') : collected.join('\n');
  return { value, next: index };
}

export function parseFrontmatter(markdown: string): Frontmatter {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
    return { data: new Map(), body: markdown };
  }
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return { data: new Map(), body: markdown };
  const data = new Map<string, FrontmatterValue>();
  const lines = markdown.slice(4, end).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lineAt(lines, index));
    if (!match?.[1]) continue;
    index = storeField(data, lines, index, match[1], match[2]);
  }
  return { data, body: markdown.slice(end + 4).replace(/^\r?\n/, '') };
}

export function frontmatterString(data: Map<string, FrontmatterValue>, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

export function frontmatterBoolean(data: Map<string, FrontmatterValue>, key: string): boolean {
  return data.get(key) === true;
}

function storeField(
  data: Map<string, FrontmatterValue>,
  lines: readonly string[],
  index: number,
  key: string,
  raw: string,
): number {
  if (BLOCK_MARKERS.has(raw)) {
    const block = readBlock(lines, index, raw);
    data.set(key, block.value);
    return block.next;
  }
  if (!raw) {
    const list = readYamlList(lines, index);
    if (list) {
      data.set(key, list.values);
      return list.next;
    }
  }
  data.set(key, parseScalar(raw));
  return index;
}

function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === '{') depth += 1;
    else if (char === '}' && depth > 0) depth -= 1;
    else if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function readYamlList(
  lines: readonly string[],
  start: number,
): { values: string[]; next: number } | undefined {
  const values: string[] = [];
  let index = start;
  while (index + 1 < lines.length && /^\s+-\s+\S/.test(lineAt(lines, index + 1))) {
    index += 1;
    values.push(
      unquote(
        lineAt(lines, index)
          .replace(/^\s+-\s+/, '')
          .trim(),
      ),
    );
  }
  if (values.length === 0) return undefined;
  return { values, next: index };
}

export function frontmatterList(data: Map<string, FrontmatterValue>, key: string): string[] {
  const value = data.get(key);
  if (Array.isArray(value)) return value.flatMap((item) => splitList(item));
  if (typeof value === 'string' && value.length > 0) return splitList(value);
  return [];
}

const COMMAND_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Cursor slash name: the skill directory, not a display name that contains spaces. */
export function cursorCommandName(directoryName: string): string | undefined {
  const name = directoryName.toLowerCase();
  return COMMAND_NAME.test(name) ? name : undefined;
}
