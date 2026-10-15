import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type PluginFormat = 'cursor' | 'agent';
export interface PluginManifest {
  [key: string]: unknown;
  name: string;
  version?: string;
  description?: string;
  skills?: string;
  agents?: string;
  commands?: string;
  rules?: string;
  hooks?: string;
  mcpServers?: string;
}
export interface InstalledPlugin {
  name: string;
  source: string;
  sourcePath: string;
  revision: string;
  format: PluginFormat;
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: string;
}
interface PluginRegistry {
  schemaVersion: 1;
  plugins: Record<string, InstalledPlugin>;
  marketplaces: Record<string, string>;
}
interface PluginCapability {
  name: string;
  available: boolean;
  detail: string;
}

export function storeRoot(): string {
  return process.env.PI_CURSOR_PLUGIN_HOME || join(homedir(), '.pi', 'cursor-plugin');
}
const empty = (): PluginRegistry => ({ schemaVersion: 1, plugins: {}, marketplaces: {} });
export function loadRegistry(root = storeRoot()): PluginRegistry {
  const file = join(root, 'registry.json');
  if (!existsSync(file)) return empty();
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRegistry(value)) throw new Error('Invalid plugin registry');
  return value;
}
export function saveRegistry(value: PluginRegistry, root = storeRoot()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, 'registry.json.tmp');
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, join(root, 'registry.json'));
}
export function safeJoin(root: string, part: string): string {
  if (
    !part ||
    part.startsWith('/') ||
    part.includes('\\') ||
    part.split('/').some((x) => x === '..')
  )
    throw new Error('Unsafe relative path: ' + part);
  const base = resolve(root);
  const target = resolve(base, part);
  if (target !== base && !target.startsWith(base + sep))
    throw new Error('Path escapes plugin root');
  return target;
}
const MANIFEST_PATHS = ['skills', 'agents', 'rules', 'commands', 'hooks', 'mcpServers'] as const;
type ManifestPath = (typeof MANIFEST_PATHS)[number];

function manifestField(manifest: PluginManifest, property: ManifestPath): unknown {
  switch (property) {
    case 'skills':
      return manifest.skills;
    case 'agents':
      return manifest.agents;
    case 'rules':
      return manifest.rules;
    case 'commands':
      return manifest.commands;
    case 'hooks':
      return manifest.hooks;
    case 'mcpServers':
      return manifest.mcpServers;
    default: {
      const unexpected: never = property;
      return unexpected;
    }
  }
}

export function readManifest(root: string): { format: PluginFormat; manifest: PluginManifest } {
  const cursor = join(root, '.cursor-plugin', 'plugin.json');
  const agent = join(root, 'plugin.json');
  const file = existsSync(cursor) ? cursor : agent;
  if (!existsSync(file)) throw new Error('No supported plugin manifest in ' + root);
  const obj: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('Invalid plugin manifest');
  const manifest = obj as PluginManifest;
  if (typeof manifest.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.name))
    throw new Error('Invalid plugin name');
  for (const property of MANIFEST_PATHS) {
    const value = manifestField(manifest, property);
    if (value !== undefined && typeof value !== 'string')
      throw new Error('Unsupported ' + property + ' manifest field');
  }
  return { format: file === cursor ? 'cursor' : 'agent', manifest };
}
export function componentPaths(
  root: string,
  manifest: PluginManifest,
  key: 'skills' | 'agents' | 'rules' | 'commands',
): string[] {
  const configured = manifestField(manifest, key);
  const directory = safeJoin(root, typeof configured === 'string' ? configured : key);
  if (!existsSync(directory)) return [];
  const results: string[] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        entry.isFile() &&
        (key === 'skills' ? entry.name === 'SKILL.md' : /\.mdc?$/.test(entry.name))
      )
        results.push(file);
    }
  }
  walk(directory);
  return results.sort();
}
export function parseSource(input: string): { repo: string; subdir: string; ref?: string } {
  const github = input
    .replace(/^github:/, '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  const parts = github.split('/').filter(Boolean);
  if (parts.length < 2 || !parts.slice(0, 2).every((x) => /^[\w.-]+$/.test(x)))
    throw new Error('Expected github:owner/repo[/plugin] or GitHub URL');
  const kind = parts.at(2);
  const gitRef = parts.at(3);
  if (kind === 'tree' && gitRef && parts.length >= 4)
    return { repo: parts.slice(0, 2).join('/'), ref: gitRef, subdir: parts.slice(4).join('/') };
  return { repo: parts.slice(0, 2).join('/'), subdir: parts.slice(2).join('/') };
}
export function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 8,
  });
  if (result.status !== 0)
    throw new Error('git failed: ' + (result.stderr || result.error?.message || args.join(' ')));
  return result.stdout.trim();
}
function keptEnabled(previous: unknown): boolean {
  if (!previous || typeof previous !== 'object') return true;
  return Reflect.get(previous, 'enabled') !== false;
}

export function commitInstalledPlugin(input: {
  sourceDir: string;
  source: string;
  sourcePath: string;
  revision: string;
  home: string;
}): InstalledPlugin {
  const { format, manifest } = readManifest(input.sourceDir);
  const registry = loadRegistry(input.home);
  const pluginsDir = join(input.home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
  const target = join(pluginsDir, manifest.name);
  const staging = join(pluginsDir, `.${manifest.name}.incoming`);
  const backup = join(pluginsDir, `.${manifest.name}.previous`);
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(input.sourceDir, staging, {
      recursive: true,
      filter: (item) => !item.split(sep).includes('.git'),
    });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, backup);
  const entry: InstalledPlugin = {
    name: manifest.name,
    source: input.source,
    sourcePath: input.sourcePath,
    revision: input.revision,
    format,
    manifest,
    enabled: keptEnabled(Reflect.get(registry.plugins, manifest.name)),
    installedAt: new Date().toISOString(),
  };
  try {
    renameSync(staging, target);
    Reflect.set(registry.plugins, manifest.name, entry);
    saveRegistry(registry, input.home);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (existsSync(backup)) renameSync(backup, target);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
  return entry;
}

export function install(source: string, home = storeRoot()): InstalledPlugin {
  const { repo, subdir, ref } = parseSource(source);
  const root = join(home, 'cache');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, 'download-' + process.pid + '-' + Date.now());
  try {
    git([
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      'https://github.com/' + repo + '.git',
      tmp,
    ]);
    git(['checkout', ref || 'HEAD'], tmp);
    const revision = git(['rev-parse', 'HEAD'], tmp);
    const path = subdir ? safeJoin(tmp, subdir) : tmp;
    return commitInstalledPlugin({ sourceDir: path, source, sourcePath: subdir, revision, home });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const NOT_INSTALLED = 'Plugin not installed: ';

function isRegistry(value: unknown): value is PluginRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    Reflect.get(value, 'schemaVersion') === 1 &&
    isStringRecord(Reflect.get(value, 'plugins')) &&
    isStringRecord(Reflect.get(value, 'marketplaces'))
  );
}

function isStringRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requirePlugin(registry: PluginRegistry, name: string): InstalledPlugin {
  const plugin = Object.values(registry.plugins).find((entry) => entry.name === name);
  if (!plugin) throw new Error(NOT_INSTALLED + name);
  return plugin;
}

export function uninstall(name: string, home = storeRoot()): void {
  const registry = loadRegistry(home);
  const plugin = requirePlugin(registry, name);
  rmSync(join(home, 'plugins', plugin.name), { recursive: true, force: true });
  Reflect.deleteProperty(registry.plugins, plugin.name);
  saveRegistry(registry, home);
}
export function setEnabled(name: string, enabled: boolean, home = storeRoot()): void {
  const registry = loadRegistry(home);
  requirePlugin(registry, name).enabled = enabled;
  saveRegistry(registry, home);
}
export function inspect(
  name: string,
  home = storeRoot(),
): { entry: InstalledPlugin; capabilities: PluginCapability[] } {
  const entry = requirePlugin(loadRegistry(home), name);
  const root = join(home, 'plugins', name);
  const capabilities: PluginCapability[] = (['skills', 'commands', 'agents', 'rules'] as const).map(
    (key) => ({
      name: key,
      available: componentPaths(root, entry.manifest, key).length > 0,
      detail:
        key === 'skills'
          ? 'Loaded as Pi skills and as Cursor slash commands'
          : key === 'commands'
            ? 'Loaded as Pi prompt templates'
            : key === 'agents'
              ? 'Spawned by the task tool using the agent markdown'
              : 'alwaysApply rules are injected into the Pi system prompt',
    }),
  );
  capabilities.push({
    name: 'hooks',
    available: false,
    detail: 'Not executed. pstack does not ship hooks.',
  });
  capabilities.push({
    name: 'mcp',
    available: false,
    detail:
      'pstack does not ship MCP servers. User servers from ~/.cursor/mcp.json, the project, and enabled plugins are registered for non-readonly agents.',
  });
  return { entry, capabilities };
}
export function addMarketplace(name: string, source: string, home = storeRoot()): void {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid marketplace name');
  parseSource(source);
  const registry = loadRegistry(home);
  Reflect.set(registry.marketplaces, name, source);
  saveRegistry(registry, home);
}
export function resolvePlugin(name: string, home = storeRoot()): string {
  if (name.startsWith('github:') || name.startsWith('https://github.com/')) return name;
  const markets = loadRegistry(home).marketplaces;
  const split = name.split(':', 2);
  const market = name.includes(':') ? split.at(0) : Object.keys(markets).at(0);
  const plugin = name.includes(':') ? split.at(1) : name;
  const marketSource = market ? Reflect.get(markets, market) : undefined;
  if (!market || typeof marketSource !== 'string' || !plugin)
    throw new Error('Plugin name requires configured marketplace, or use github:owner/repo/plugin');
  return marketSource.replace(/\/$/, '') + '/' + plugin;
}
