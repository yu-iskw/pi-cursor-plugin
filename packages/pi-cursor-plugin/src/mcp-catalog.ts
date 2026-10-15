import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadRegistry, safeJoin } from './manager.js';
import { projectSlug } from './workspace-context.js';

export interface CursorMcpServer {
  name: string;
  description: string;
  config:
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { url: string; headers?: Record<string, string> };
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function mcpCatalogDir(cwd: string, homeDir = homedir()): string {
  return join(homeDir, '.cursor', 'projects', projectSlug(cwd), 'mcps');
}

export function cursorMcpServers(input: {
  home: string;
  cwd: string;
  userFile?: string;
  projectTrusted?: boolean;
}): CursorMcpServer[] {
  const files = [
    input.userFile ?? join(homedir(), '.cursor', 'mcp.json'),
    ...(input.projectTrusted ? [join(input.cwd, '.cursor', 'mcp.json')] : []),
    ...pluginMcpFiles(input.home),
  ];
  const servers = new Map<string, CursorMcpServer>();
  for (const file of files) {
    for (const server of readMcpFile(file)) servers.set(server.name, server);
  }
  return [...servers.values()];
}

export function writeMcpCatalog(directory: string, servers: readonly CursorMcpServer[]): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const indexPath = join(directory, 'index.json');
  const previous = readIndex(indexPath);
  const names = servers.map((server) => server.name);
  for (const name of previous) {
    if (!names.includes(name)) rmSync(join(directory, name), { recursive: true, force: true });
  }
  for (const server of servers) {
    const dir = join(directory, server.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SERVER_METADATA.json'),
      `${JSON.stringify({ serverIdentifier: server.name, serverName: server.name }, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'INSTRUCTIONS.md'), `${server.description}\n`);
  }
  writeFileSync(indexPath, `${JSON.stringify(names, null, 2)}\n`);
}

const MCP_HEADING = '# Cursor MCP servers';

export function formatMcpMessage(
  directory: string,
  servers: readonly CursorMcpServer[],
  options?: { readonlyDisabled?: boolean },
): string {
  if (options?.readonlyDisabled) {
    return [
      MCP_HEADING,
      '',
      'MCP is disabled for this agent because it is readonly.',
      'Spawn with readonly false when the task needs MCP.',
    ].join('\n');
  }
  if (servers.length === 0) {
    return [
      MCP_HEADING,
      '',
      'No Cursor MCP servers are configured.',
      `Inspect \`${directory}\` to confirm.`,
      '/why and /reflect should record each missing evidence category as a gap.',
    ].join('\n');
  }
  const lines = servers.map(
    (server) => `- ${server.name}: ${server.description} (${join(directory, server.name)})`,
  );
  return [
    MCP_HEADING,
    '',
    'These are the enabled MCP servers. A readonly Task passes --no-mcp and cannot call them.',
    `Inspect \`${directory}\` for server metadata.`,
    lines.join('\n'),
  ].join('\n');
}

function pluginMcpFiles(home: string): string[] {
  const files: string[] = [];
  for (const entry of Object.values(loadRegistry(home).plugins)) {
    if (!entry.enabled || typeof entry.manifest.mcpServers !== 'string') continue;
    const root = join(home, 'plugins', entry.name);
    try {
      files.push(safeJoin(root, entry.manifest.mcpServers));
    } catch {
      continue;
    }
  }
  return files;
}

function readMcpFile(file: string): CursorMcpServer[] {
  const servers = mcpServerRecord(file);
  if (!servers) return [];
  const found: CursorMcpServer[] = [];
  for (const name of Object.keys(servers)) {
    const server = serverFromEntry(name, Reflect.get(servers, name));
    if (server) found.push(server);
  }
  return found;
}

function mcpServerRecord(file: string): object | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const servers: unknown = Reflect.get(parsed, 'mcpServers');
  return isRecord(servers) ? servers : undefined;
}

function serverFromEntry(name: string, entry: unknown): CursorMcpServer | undefined {
  if (!SERVER_NAME.test(name) || !isRecord(entry)) return undefined;
  const config = toConfig(entry);
  if (!config) return undefined;
  return { name, description: descriptionOf(entry, name), config };
}

function isRecord(value: unknown): value is object {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function descriptionOf(entry: object, name: string): string {
  const value: unknown = Reflect.get(entry, 'description');
  return typeof value === 'string' && value.trim() ? value.trim() : name;
}

function toConfig(entry: object): CursorMcpServer['config'] | undefined {
  const command: unknown = Reflect.get(entry, 'command');
  if (typeof command === 'string' && command.trim()) {
    const config: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    } = { command: command.trim() };
    const args = stringList(Reflect.get(entry, 'args'));
    const env = stringRecord(Reflect.get(entry, 'env'));
    const cwd: unknown = Reflect.get(entry, 'cwd');
    if (args) config.args = args;
    if (env) config.env = env;
    if (typeof cwd === 'string' && cwd.trim()) config.cwd = cwd.trim();
    return config;
  }
  const url: unknown = Reflect.get(entry, 'url');
  if (typeof url !== 'string' || !url.trim()) return undefined;
  const headers = stringRecord(Reflect.get(entry, 'headers'));
  return headers ? { url: url.trim(), headers } : { url: url.trim() };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    items.push(item);
  }
  return items;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const item: unknown = Reflect.get(value, key);
    if (typeof item !== 'string') return undefined;
    Reflect.set(result, key, item);
  }
  return result;
}

function readIndex(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === 'string' && SERVER_NAME.test(item),
    );
  } catch {
    return [];
  }
}
