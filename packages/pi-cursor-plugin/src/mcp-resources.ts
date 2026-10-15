import { spawn } from 'node:child_process';

import type { CursorMcpServer, McpResourceDescriptor } from './mcp-catalog.js';

const LIST_TIMEOUT_MS = 3000;

export async function listedResources(
  servers: readonly CursorMcpServer[],
): Promise<McpResourceDescriptor[]> {
  const found: McpResourceDescriptor[] = [];
  for (const server of servers) found.push(...(await listServerResources(server)));
  return found;
}

async function listServerResources(server: CursorMcpServer): Promise<McpResourceDescriptor[]> {
  if ('command' in server.config) return listStdioResources(server);
  return listHttpResources(server);
}

export async function listHttpResources(server: CursorMcpServer): Promise<McpResourceDescriptor[]> {
  if (!('url' in server.config)) return [];
  const url = httpUrl(server.config.url);
  if (!url) return [];
  try {
    const result = await requestHttpResources(url, server.config.headers);
    return resourcesFrom(server.name, result);
  } catch {
    return [];
  }
}

export async function listStdioResources(
  server: CursorMcpServer,
): Promise<McpResourceDescriptor[]> {
  if (!('command' in server.config)) return [];
  const result = await requestResources(server.config);
  return resourcesFrom(server.name, result);
}

function requestResources(config: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: childEnv(config.env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '';
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), LIST_TIMEOUT_MS);
    child.on('error', () => finish(undefined));
    child.on('close', () => finish(undefined));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) acceptLine(child, line, finish);
    });
    writeMessage(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: initializeParams(),
    });
  });
}

function acceptLine(
  child: ReturnType<typeof spawn>,
  line: string,
  finish: (value: unknown) => void,
): void {
  const initialized = messageResult(line, 1);
  if (initialized) {
    writeMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    writeMessage(child, { jsonrpc: '2.0', id: 2, method: 'resources/list' });
  }
  const listed = messageResult(line, 2);
  if (listed) finish(listed.result);
}

function messageResult(line: string, id: number): { result: unknown } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'id') !== id) return undefined;
  return { result: Reflect.get(parsed, 'result') };
}

function writeMessage(child: ReturnType<typeof spawn>, message: object): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.write(`${JSON.stringify(message)}\n`);
}

function initializeParams(): object {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pi-cursor-plugin', version: '0.1.0' },
  };
}

function childEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!extra) return env;
  for (const key of Object.keys(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value: unknown = Reflect.get(extra, key);
    if (typeof value === 'string') Reflect.set(env, key, value);
  }
  return env;
}

function resourcesFrom(server: string, result: unknown): McpResourceDescriptor[] {
  if (!result || typeof result !== 'object') return [];
  const resources: unknown = Reflect.get(result, 'resources');
  if (!Array.isArray(resources)) return [];
  const found: McpResourceDescriptor[] = [];
  for (const item of resources) {
    const descriptor = resourceDescriptor(server, item);
    if (descriptor) found.push(descriptor);
  }
  return found;
}

function resourceDescriptor(server: string, item: unknown): McpResourceDescriptor | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const uri: unknown = Reflect.get(item, 'uri');
  const name: unknown = Reflect.get(item, 'name');
  if (typeof uri !== 'string' || typeof name !== 'string' || uri.startsWith('ui://'))
    return undefined;
  const description: unknown = Reflect.get(item, 'description');
  const mimeType: unknown = Reflect.get(item, 'mimeType');
  return {
    server,
    name,
    uri,
    ...(typeof description === 'string' && description.trim()
      ? { description: description.trim() }
      : {}),
    ...(typeof mimeType === 'string' && mimeType.trim() ? { mimeType: mimeType.trim() } : {}),
  };
}

function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function requestHttpResources(
  url: string,
  extra: Record<string, string> | undefined,
): Promise<unknown> {
  const headers = requestHeaders(extra);
  const signal = AbortSignal.timeout(LIST_TIMEOUT_MS);
  const initialized = await postRpc({
    url,
    headers,
    id: 1,
    method: 'initialize',
    params: initializeParams(),
    signal,
  });
  if (initialized.sessionId) headers.set('Mcp-Session-Id', initialized.sessionId);
  await postRpc({ url, headers, method: 'notifications/initialized', signal });
  const listed = await postRpc({ url, headers, id: 2, method: 'resources/list', signal });
  return listed.result;
}

async function postRpc(input: {
  url: string;
  headers: Headers;
  method: string;
  signal: AbortSignal;
  id?: number;
  params?: object;
}): Promise<{ result: unknown; sessionId?: string }> {
  const body: { jsonrpc: '2.0'; method: string; id?: number; params?: object } = {
    jsonrpc: '2.0',
    method: input.method,
  };
  if (input.id !== undefined) body.id = input.id;
  if (input.params) body.params = input.params;
  const response = await fetch(input.url, {
    method: 'POST',
    headers: input.headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: input.signal,
  });
  const sessionId = response.headers.get('mcp-session-id') ?? undefined;
  const text = await response.text();
  if (input.id === undefined) return { result: undefined, sessionId };
  return { result: rpcResult(text, response.headers.get('content-type'), input.id), sessionId };
}

function requestHeaders(extra: Record<string, string> | undefined): Headers {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  });
  if (!extra) return headers;
  for (const key of Object.keys(extra)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    const value: unknown = Reflect.get(extra, key);
    if (typeof value === 'string' && !value.includes('\n') && !value.includes('\r')) {
      headers.set(key, value);
    }
  }
  return headers;
}

function rpcResult(body: string, contentType: string | null, id: number): unknown {
  if (contentType?.includes('text/event-stream')) return sseResult(body, id);
  return jsonResult(body, id);
}

function jsonResult(body: string, id: number): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'id') !== id) return undefined;
  return Reflect.get(parsed, 'result');
}

function sseResult(body: string, id: number): unknown {
  for (const event of body.split('\n\n')) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    const result = data ? jsonResult(data, id) : undefined;
    if (result !== undefined) return result;
  }
  return undefined;
}
