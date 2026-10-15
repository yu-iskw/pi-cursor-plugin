import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  cursorCommandName,
  frontmatterBoolean,
  frontmatterList,
  frontmatterString,
  parseFrontmatter,
} from './frontmatter.js';
import { componentPaths, loadRegistry, safeJoin, storeRoot } from './manager.js';

import type { PluginManifest } from './manager.js';

export interface SkillRecord {
  plugin: string;
  filePath: string;
  baseDir: string;
  directoryName: string;
  name: string;
  description: string;
  body: string;
  disableModelInvocation: boolean;
  commandName: string;
  paths: string[];
}

export interface AgentRecord {
  plugin: string;
  name: string;
  description: string;
  filePath: string;
  body: string;
  isBackground: boolean;
}

export interface RuleRecord {
  path: string;
  description: string;
  alwaysApply: boolean;
  globs: string[];
  body: string;
}

export interface Catalog {
  skills: SkillRecord[];
  agents: AgentRecord[];
  skillPaths: string[];
  promptPaths: string[];
}

function readMarkdown(file: string): string {
  return readFileSync(file, 'utf8');
}

function skillRecord(plugin: string, file: string): SkillRecord {
  const parsed = parseFrontmatter(readMarkdown(file));
  const baseDir = dirname(file);
  const directoryName = basename(baseDir);
  return {
    plugin,
    filePath: file,
    baseDir,
    directoryName,
    name: frontmatterString(parsed.data, 'name') || directoryName,
    description: frontmatterString(parsed.data, 'description'),
    body: parsed.body.trim(),
    disableModelInvocation: frontmatterBoolean(parsed.data, 'disable-model-invocation'),
    commandName: cursorCommandName(directoryName) ?? '',
    paths: frontmatterList(parsed.data, 'paths'),
  };
}

function agentRecord(plugin: string, file: string): AgentRecord {
  const parsed = parseFrontmatter(readMarkdown(file));
  const fallback = basename(file).replace(/\.mdc?$/, '');
  return {
    plugin,
    name: frontmatterString(parsed.data, 'name') || fallback,
    description: frontmatterString(parsed.data, 'description'),
    filePath: file,
    body: parsed.body.trim(),
    isBackground:
      frontmatterBoolean(parsed.data, 'is_background') ||
      frontmatterBoolean(parsed.data, 'isBackground'),
  };
}

function ruleRecord(file: string): RuleRecord {
  const parsed = parseFrontmatter(readMarkdown(file));
  return {
    path: file,
    description: frontmatterString(parsed.data, 'description'),
    alwaysApply: frontmatterBoolean(parsed.data, 'alwaysApply'),
    globs: [...frontmatterList(parsed.data, 'globs'), ...frontmatterList(parsed.data, 'paths')],
    body: parsed.body.trim(),
  };
}

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const results: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.mdc?$/.test(entry.name)) results.push(file);
    }
  };
  walk(directory);
  return results.sort();
}

function skillDirectory(root: string, manifest: PluginManifest): string | undefined {
  const configured = typeof manifest.skills === 'string' ? manifest.skills : 'skills';
  const directory = safeJoin(root, configured);
  return existsSync(directory) ? directory : undefined;
}

export function loadCatalog(home = storeRoot()): Catalog {
  const skills: SkillRecord[] = [];
  const agents: AgentRecord[] = [];
  const skillPaths: string[] = [];
  const promptPaths: string[] = [];
  for (const entry of Object.values(loadRegistry(home).plugins)) {
    if (!entry.enabled) continue;
    const root = join(home, 'plugins', entry.name);
    if (!existsSync(root)) continue;
    const directory = skillDirectory(root, entry.manifest);
    if (directory) skillPaths.push(directory);
    for (const file of componentPaths(root, entry.manifest, 'skills')) {
      skills.push(skillRecord(entry.name, file));
    }
    for (const file of componentPaths(root, entry.manifest, 'agents')) {
      agents.push(agentRecord(entry.name, file));
    }
    promptPaths.push(...componentPaths(root, entry.manifest, 'commands'));
  }
  skills.sort((left, right) => left.commandName.localeCompare(right.commandName));
  agents.sort((left, right) => left.name.localeCompare(right.name));
  return { skills, agents, skillPaths, promptPaths };
}

export function loadRules(input: {
  home?: string;
  cwd: string;
  userRulesDir: string;
}): RuleRecord[] {
  const home = input.home ?? storeRoot();
  const files = new Set<string>();
  for (const entry of Object.values(loadRegistry(home).plugins)) {
    if (!entry.enabled) continue;
    const root = join(home, 'plugins', entry.name);
    if (!existsSync(root)) continue;
    for (const file of componentPaths(root, entry.manifest, 'rules')) files.add(file);
  }
  for (const file of markdownFiles(input.userRulesDir)) files.add(file);
  for (const file of markdownFiles(join(input.cwd, '.cursor', 'rules'))) files.add(file);
  return [...files].sort().map(ruleRecord);
}

function bullet(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

function matchSegment(pattern: string, segment: string): boolean {
  let patternIndex = 0;
  let segmentIndex = 0;
  let star = -1;
  let mark = -1;
  while (segmentIndex < segment.length) {
    const patternChar = pattern.charAt(patternIndex);
    const segmentChar = segment.charAt(segmentIndex);
    if (patternIndex < pattern.length && (patternChar === '?' || patternChar === segmentChar)) {
      patternIndex += 1;
      segmentIndex += 1;
    } else if (patternIndex < pattern.length && patternChar === '*') {
      star = patternIndex;
      mark = segmentIndex;
      patternIndex += 1;
    } else if (star >= 0) {
      patternIndex = star + 1;
      mark += 1;
      segmentIndex = mark;
    } else return false;
  }
  while (patternIndex < pattern.length && pattern.charAt(patternIndex) === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

function matchParts(parts: readonly string[], segments: readonly string[]): boolean {
  if (parts.length === 0) return segments.length === 0;
  const head = parts[0];
  const rest = parts.slice(1);
  if (head === '**') {
    if (rest.length === 0) return true;
    for (let index = 0; index <= segments.length; index += 1) {
      if (matchParts(rest, segments.slice(index))) return true;
    }
    return false;
  }
  const segment = segments[0];
  if (segments.length === 0 || !matchSegment(head, segment)) return false;
  return matchParts(rest, segments.slice(1));
}

export function globMatches(glob: string, filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return matchParts(glob.replaceAll('\\', '/').split('/'), normalized.split('/'));
}

function isPathChar(char: string): boolean {
  const alphanumeric =
    (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9');
  return (
    alphanumeric ||
    char === '.' ||
    char === '_' ||
    char === '~' ||
    char === '+' ||
    char === '-' ||
    char === '/'
  );
}

function rememberPath(found: string[], token: string): void {
  const dot = token.lastIndexOf('.');
  const slash = token.lastIndexOf('/');
  const extension = token.slice(dot + 1);
  if (dot <= slash || extension.length === 0) return;
  if (!found.includes(token)) found.push(token);
}

const FILE_TOOLS = new Set(['read', 'edit', 'write', 'grep']);

export function toolPaths(toolName: string, input: unknown): string[] {
  if (!FILE_TOOLS.has(toolName) || !input || typeof input !== 'object') return [];
  const path: unknown = Reflect.get(input, 'path');
  return typeof path === 'string' && path.trim() ? [path.trim()] : [];
}

export function pathsInText(text: string): string[] {
  const found: string[] = [];
  let token = '';
  for (const char of text) {
    if (isPathChar(char)) token += char;
    else {
      rememberPath(found, token);
      token = '';
    }
  }
  rememberPath(found, token);
  return found;
}

export function formatRuleMessage(
  rules: RuleRecord[],
  skills: SkillRecord[],
  activeFiles: readonly string[] = [],
): string {
  const always = rules.filter((rule) => rule.alwaysApply);
  const pathRules = rules.filter((rule) => !rule.alwaysApply && rule.globs.length > 0);
  const matchedRules = pathRules.filter((rule) =>
    activeFiles.some((file) => rule.globs.some((glob) => globMatches(glob, file))),
  );
  const indexedRules = pathRules.filter((rule) => !matchedRules.includes(rule));
  const requestable = rules.filter((rule) => !rule.alwaysApply && rule.globs.length === 0);
  const pathSkills = skills.filter((skill) => skill.paths.length > 0);
  const matchedSkills = pathSkills.filter((skill) =>
    activeFiles.some((file) => skill.paths.some((glob) => globMatches(glob, file))),
  );
  const indexedSkills = pathSkills.filter((skill) => !matchedSkills.includes(skill));
  const sections: string[] = [];
  if (always.length > 0) {
    sections.push(
      always
        .map((rule) => `## ${basename(rule.path)}\nPath: ${rule.path}\n\n${rule.body}`)
        .join('\n\n'),
    );
  }
  if (matchedRules.length > 0) {
    sections.push(
      matchedRules
        .map((rule) => `## ${basename(rule.path)}\nPath: ${rule.path}\n\n${rule.body}`)
        .join('\n\n'),
    );
  }
  if (indexedRules.length > 0) {
    sections.push(
      `## Path-scoped rules\nRead the file when a matching path is in play.\n${bullet(
        indexedRules.map((rule) => `${rule.path} (${rule.globs.join(', ')})`),
      )}`,
    );
  }
  if (requestable.length > 0) {
    sections.push(
      `## Available rules\nRead a file when its description matches the task.\n${bullet(
        requestable.map((rule) => `${rule.description || basename(rule.path)}: ${rule.path}`),
      )}`,
    );
  }
  if (matchedSkills.length > 0) {
    sections.push(matchedSkills.map((skill) => skillInvocation(skill, '')).join('\n\n'));
  }
  if (indexedSkills.length > 0) {
    sections.push(
      `## Path-scoped skills\nRead the skill when a matching file is in play.\n${bullet(
        indexedSkills.map((skill) => `${skill.filePath} (${skill.paths.join(', ')})`),
      )}`,
    );
  }
  if (sections.length === 0) return '';
  return `# Cursor plugin rules\n\n${sections.join('\n\n')}`;
}

export function appendSection(current: string, section: string): string {
  const addition = section.trim();
  if (!addition) return current;
  if (!current.trim()) return addition;
  if (current.includes(addition)) return current;
  return `${current.trim()}\n\n${addition}`;
}

export function skillInvocation(skill: SkillRecord, args: string): string {
  const name = skill.name
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
  const block = `<skill name="${name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
  const task = args.trim();
  return task ? `${block}\n\n${task}` : block;
}

const PSTACK_COMMANDS = [
  'poteto-mode',
  'poteto-help',
  'setup-pstack',
  'how',
  'why',
  'teach',
  'architect',
  'arena',
  'swarm',
  'interrogate',
  'no-comments',
  'unslop',
  'reflect',
] as const;

const PSTACK_AGENTS = ['poteto-agent', 'comment-sicko'] as const;

export function formatDoctor(
  pluginName: string,
  catalog: Catalog,
  rules: RuleRecord[],
  mcpNames: readonly string[] = [],
): string {
  const skills = catalog.skills.filter((skill) => skill.plugin === pluginName);
  const agents = catalog.agents.filter((agent) => agent.plugin === pluginName);
  const renamed = skills
    .filter((skill) => skill.name !== skill.commandName)
    .map((skill) => `${skill.commandName} → ${skill.name}`);
  const lines = [
    `${pluginName}: ${skills.length} skills, ${agents.length} agents, ${rules.length} rules in context`,
    `skill paths: ${catalog.skillPaths.join(', ') || '(none)'}`,
    `slash commands: ${skills.map((skill) => `/${skill.commandName}`).join(' ') || '(none)'}`,
    `agents: ${agents.map((agent) => agent.name).join(', ') || '(none)'}`,
    'Task tool: spawns poteto-agent, comment-sicko, and generalPurpose',
    'AskQuestion tool: single or multiple questions, with allow_multiple',
    'TodoWrite tool: available for the session todo list',
    'hooks: not executed',
    mcpNames.length > 0 ? `mcp: ${mcpNames.join(', ')}` : 'mcp: none configured',
  ];
  if (renamed.length > 0) lines.push(`display names: ${renamed.join('; ')}`);
  if (pluginName === 'pstack') {
    const commands = new Set(skills.map((skill) => skill.commandName));
    const agentNames = new Set(agents.map((agent) => agent.name));
    const missingCommands = PSTACK_COMMANDS.filter((name) => !commands.has(name));
    const missingAgents = PSTACK_AGENTS.filter((name) => !agentNames.has(name));
    lines.push(
      missingCommands.length === 0 && missingAgents.length === 0
        ? 'pstack checklist: skills and agents match the original plugin'
        : `pstack checklist missing: ${[...missingCommands, ...missingAgents].join(', ')}`,
    );
  }
  return lines.join('\n');
}
