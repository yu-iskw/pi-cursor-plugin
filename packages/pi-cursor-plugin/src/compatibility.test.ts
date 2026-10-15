import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendSection,
  formatDoctor,
  formatRuleMessage,
  globMatches,
  loadCatalog,
  loadRules,
  replaceSection,
  skillInvocation,
  toolPaths,
} from './catalog.js';
import {
  cloudReadiness,
  githubRepoUrl,
  resolvedCloudModel,
  startCloudTask,
  wantsCloud,
} from './cloud-task.js';
import { dispatchCursorPlugin } from './commands.js';
import {
  applyTodos,
  formatAskWithoutUi,
  formatTodoMessage,
  formatTodos,
  normalizeQuestions,
  sessionTodoFile,
} from './cursor-actions.js';
import { frontmatterList, parseFrontmatter } from './frontmatter.js';
import { git, loadRegistry, saveRegistry } from './manager.js';
import {
  cursorMcpServers,
  formatMcpMessage,
  mcpCatalogDir,
  writeMcpCatalog,
} from './mcp-catalog.js';
import { registerCursorTools } from './register-tools.js';
import {
  findSession,
  listInstalledModels,
  modelFamily,
  modelRejection,
  parseModelList,
  parentModelArg,
  planTask,
  rejectedModelMessage,
  runSubagent,
  shouldBackground,
  suggestModels,
} from './subagent.js';
import {
  formatWorkspaceContext,
  projectSlug,
  publishCursorTranscript,
} from './workspace-context.js';
import { claimWriter, createTaskWorktree, releaseWriter, rememberCheckout } from './worktree.js';

import type { InstalledPlugin } from './manager.js';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';

function writePstack(home: string): void {
  const root = join(home, 'plugins', 'pstack');
  mkdirSync(join(root, '.cursor-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'poteto-mode'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'rules'), { recursive: true });
  writeFileSync(
    join(root, '.cursor-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'pstack',
      version: '0.15.25',
      skills: './skills/',
      agents: './agents/',
      rules: './rules/',
    }),
  );
  writeFileSync(
    join(root, 'skills', 'poteto-mode', 'SKILL.md'),
    '---\nname: Poteto Mode\ndescription: poteto style\ndisable-model-invocation: true\n---\nFollow the playbook.\n',
  );
  writeFileSync(
    join(root, 'agents', 'poteto-agent.md'),
    '---\nname: poteto-agent\ndescription: delegate\nis_background: true\n---\nRead the skill file.\n',
  );
  writeFileSync(
    join(root, 'agents', 'comment-sicko.md'),
    '---\nname: comment-sicko\ndescription: comments\n---\nDelete comments.\n',
  );
  writeFileSync(
    join(root, 'rules', 'local.mdc'),
    '---\ndescription: local rule\nalwaysApply: true\n---\nAlways use the local marker.\n',
  );
  const entry: InstalledPlugin = {
    name: 'pstack',
    source: 'github:cursor/plugins/pstack',
    sourcePath: 'pstack',
    revision: 'abc123',
    format: 'cursor',
    manifest: {
      name: 'pstack',
      version: '0.15.25',
      skills: './skills/',
      agents: './agents/',
      rules: './rules/',
    },
    enabled: true,
    installedAt: '2026-10-15T00:00:00.000Z',
  };
  saveRegistry({ schemaVersion: 1, plugins: { pstack: entry }, marketplaces: {} }, home);
}

function writePluginMcp(
  home: string,
  name: string,
  enabled: boolean,
  mcpServers: Record<string, unknown>,
): void {
  const root = join(home, 'plugins', name);
  mkdirSync(join(root, '.cursor-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.cursor-plugin', 'plugin.json'),
    JSON.stringify({ name, mcpServers: './mcp.json' }),
  );
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers }));
  const registry = loadRegistry(home);
  Reflect.set(registry.plugins, name, {
    name,
    source: `github:example/${name}`,
    sourcePath: name,
    revision: 'abc123',
    format: 'cursor',
    manifest: { name, mcpServers: './mcp.json' },
    enabled,
    installedAt: '2026-10-15T00:00:00.000Z',
  });
  saveRegistry(registry, home);
}

describe('pstack compatibility', () => {
  it('maps the Cursor slash name and skill directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-catalog-'));
    try {
      writePstack(home);
      const catalog = loadCatalog(home);
      const skill = catalog.skills.find((item) => item.commandName === 'poteto-mode');
      if (!skill) throw new Error('missing poteto-mode');
      expect(skill.name).toBe('Poteto Mode');
      expect(skill.disableModelInvocation).toBe(true);
      expect(catalog.agents.map((agent) => agent.name)).toEqual(['comment-sicko', 'poteto-agent']);
      expect(catalog.agents.find((agent) => agent.name === 'poteto-agent')?.isBackground).toBe(
        true,
      );
      expect(catalog.agents.find((agent) => agent.name === 'comment-sicko')?.isBackground).toBe(
        false,
      );
      const message = skillInvocation(skill, 'ship it');
      expect(message).toContain(`References are relative to ${skill.baseDir}`);
      expect(message).toContain('Follow the playbook.');
      expect(message).not.toContain('disable-model-invocation');
      expect(message.endsWith('ship it')).toBe(true);
      expect(catalog.skillPaths[0]).toContain(`${join('plugins', 'pstack', 'skills')}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('injects always-on rules and only indexes requestable rules', () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-rules-'));
    const cwd = join(home, 'project');
    const userRules = join(home, 'user-rules');
    try {
      writePstack(home);
      mkdirSync(userRules, { recursive: true });
      writeFileSync(
        join(userRules, 'notes.mdc'),
        '---\ndescription: requestable note\n---\nSECRET_RULE_BODY\n',
      );
      writeFileSync(
        join(userRules, 'typescript.mdc'),
        '---\ndescription: ts rule\nglobs: ["**/*.ts"]\n---\nUSE_EXACT_TYPES\n',
      );
      const rules = loadRules({ home, cwd, userRulesDir: userRules });
      const skills = loadCatalog(home).skills;
      const formatted = formatRuleMessage(rules, skills);
      expect(formatted).toContain('Always use the local marker.');
      expect(formatted).toContain('requestable note');
      expect(formatted).not.toContain('SECRET_RULE_BODY');
      expect(formatted).not.toContain('USE_EXACT_TYPES');
      expect(formatted).toContain('Path-scoped rules');
      const matched = formatRuleMessage(rules, skills, [
        ...['src/app.ts'],
        ...toolPaths('read', { path: ' src/app.ts ' }),
      ]);
      expect(matched).toContain('USE_EXACT_TYPES');
      expect(matched).not.toContain('Path-scoped rules');
      expect(toolPaths('bash', {})).toEqual([]);
      expect(toolPaths('read', {})).toEqual([]);
      expect(appendSection(formatted, formatted)).toBe(formatted);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('plans a readonly general-purpose subagent without an inherited model', () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-plan-'));
    try {
      writePstack(home);
      const catalog = loadCatalog(home);
      const plan = planTask(
        {
          prompt: 'Explain the loader',
          description: 'how',
          subagentType: 'generalPurpose',
          model: 'auto',
          readonly: true,
          cwd: home,
          depth: 0,
          sessionId: 'task-how0001',
          sessionDir: join(home, 'tasks', 'sessions'),
          resume: false,
        },
        catalog.agents,
        catalog.skills,
      );
      expect('launch' in plan).toBe(true);
      if (!('launch' in plan)) return;
      expect(plan.launch.args).toEqual([
        '--print',
        '--session-id',
        'task-how0001',
        '--session-dir',
        join(home, 'tasks', 'sessions'),
        '--no-mcp',
        '--tools',
        'read,grep,find,ls',
      ]);
      expect(plan.launch.input).toContain('Parent-provided poteto-mode SKILL.md path:');
      expect(plan.launch.input).toContain('general-purpose coding subagent');
      expect(plan.launch.env.PI_CURSOR_TASK_DEPTH).toBe('1');
      const missing = planTask(
        { ...blankRequest(home), subagentType: 'missing' },
        catalog.agents,
        catalog.skills,
      );
      const rejected = planTask(
        { ...blankRequest(home), model: '-rf', subagentType: 'poteto-agent' },
        catalog.agents,
        catalog.skills,
      );
      expect('error' in missing && missing.error.includes('Unknown subagent_type missing')).toBe(
        true,
      );
      expect('error' in rejected && rejected.error.includes('Rejected model slug')).toBe(true);
      const cloud = planTask(
        { ...blankRequest(home), environment: 'cloud', cloudBaseBranch: 'main' },
        catalog.agents,
        catalog.skills,
      );
      expect('error' in cloud && cloud.error.includes('Cursor cloud runtime')).toBe(true);
      const resumed = planTask(
        { ...blankRequest(home), resume: true, sessionId: 'task-missing1' },
        catalog.agents,
        catalog.skills,
      );
      expect('error' in resumed && resumed.error.includes('No Pi session')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs the planned subagent process and reports the pstack checklist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-run-'));
    try {
      writePstack(home);
      const catalog = loadCatalog(home);
      const plan = planTask(
        {
          prompt: 'Read the skill',
          description: 'delegate',
          subagentType: 'poteto-agent',
          model: 'claude-opus-5-5-xhigh',
          readonly: false,
          cwd: home,
          depth: 1,
          sessionId: 'task-delegate',
          sessionDir: join(home, 'tasks', 'sessions'),
          resume: false,
        },
        catalog.agents,
        catalog.skills,
      );
      if (!('launch' in plan)) throw new Error('expected a launch');
      const script = join(home, 'echo.mjs');
      writeFileSync(
        script,
        'let data="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>{data+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:data}))});\n',
      );
      const output = await runSubagent({
        ...plan.launch,
        bin: process.execPath,
        args: [script, ...plan.launch.args],
      });
      const parsed = JSON.parse(output.stdout) as { argv: string[]; stdin: string };
      expect(parsed.argv).toContain('--model');
      expect(parsed.argv).toContain('claude-opus-5-5-xhigh');
      expect(parsed.stdin).toContain('Read the skill file.');
      expect(parsed.stdin).toContain('Parent-provided poteto-mode SKILL.md path:');
      const doctor = dispatchCursorPlugin('doctor pstack', {
        home,
        cwd: home,
        userRulesDir: join(home, 'empty-rules'),
      });
      expect(doctor.message).toContain('display names: poteto-mode → Poteto Mode');
      expect(doctor.message).toContain('agents: comment-sicko, poteto-agent');
      expect(formatDoctor('pstack', catalog, [])).toContain('pstack checklist missing:');
      expect(doctor.reload).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges todos and formats a dialog-free question', () => {
    const merged = applyTodos([{ id: 'a', content: 'first', status: 'pending' }], {
      merge: true,
      todos: [{ id: 'a', content: 'first', status: 'completed' }],
    });
    expect(formatTodos(merged)).toContain('[x] a: first');
    const questions = normalizeQuestions({
      question: 'Budget?',
      options: ['large', 'small'],
    });
    expect(formatAskWithoutUi(questions)).toContain('large');
    expect(
      normalizeQuestions({
        questions: [{ question: 'Areas?', options: [{ label: 'style' }], allow_multiple: true }],
      })[0],
    ).toEqual({ question: 'Areas?', options: [{ label: 'style' }], allowMultiple: true });
    expect(shouldBackground(undefined, true)).toBe(true);
    expect(shouldBackground(false, true)).toBe(false);
  });

  it('folds skill descriptions, resumes a saved session, and attaches path skills', () => {
    const folded = parseFrontmatter(
      '---\nname: Make Bot UI\ndescription: >-\n  Build a page\n  the user clicks.\n---\nBody\n',
    );
    expect(folded.data.get('description')).toBe('Build a page the user clicks.');
    expect(globMatches('**/*.ts', 'src/foo.ts')).toBe(true);
    expect(globMatches('**/*.ts', 'src/foo.tsx')).toBe(false);
    const home = mkdtempSync(join(tmpdir(), 'pstack-path-'));
    try {
      writePstack(home);
      const skillDir = join(home, 'plugins', 'pstack', 'skills', 'typescript-best-practices');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: typescript-best-practices\ndescription: types\npaths: ["**/*.ts", "**/*.tsx"]\n---\nPrefer exact types.\n',
      );
      const sessionDir = join(home, 'tasks', 'sessions');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'saved.jsonl'), '{"id":"task-saved01"}\n');
      expect(findSession(sessionDir, 'task-saved01')).toContain('saved.jsonl');
      const catalog = loadCatalog(home);
      const resume = planTask(
        {
          ...blankRequest(home),
          resume: true,
          sessionId: 'task-saved01',
          sessionDir,
          prompt: 'continue the checkout',
          subagentType: 'poteto-agent',
        },
        catalog.agents,
        catalog.skills,
      );
      if (!('launch' in resume)) throw new Error('expected a resumed launch');
      expect(resume.launch.input).toBe('continue the checkout');
      expect(resume.launch.args).toContain('task-saved01');
      const formatted = formatRuleMessage([], catalog.skills, ['src/app.ts']);
      expect(formatted).toContain('Prefer exact types.');
      expect(formatRuleMessage([], catalog.skills, ['README.md'])).not.toContain(
        'Prefer exact types.',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('names the closest model family and the cloud handoff', async () => {
    expect(modelFamily('grok-4.7-xhigh-fast')).toBe('grok');
    expect(modelFamily('claude-opus-5-5-xhigh')).toBe('claude');
    expect(modelFamily('composer-2.5-fast')).toBe('grok');
    expect(
      suggestModels('composer-2.5-fast', [
        'grok-4.7-high',
        'cursor-grok-4.6-low',
        'claude-opus-5-5-xhigh',
      ]),
    ).toEqual(['grok-4.7-high', 'cursor-grok-4.6-low']);
    expect(
      suggestModels('grok-4.7-xhigh-fast', ['grok-4.7-high', 'claude-opus-5-5-xhigh']),
    ).toEqual(['grok-4.7-high']);
    expect(
      suggestModels('grok-4.7-xhigh-fast', ['grok-4.7-low', 'grok-4.7-max', 'grok-4.7-high-fast']),
    ).toEqual(['grok-4.7-high-fast', 'grok-4.7-max', 'grok-4.7-low']);
    expect(rejectedModelMessage('grok-4.7-xhigh-fast', ['grok-4.7-high'])).toContain(
      'Closest grok: grok-4.7-high',
    );
    expect(parentModelArg({ id: 'grok-4.7', provider: 'cursor' }, 'xhigh')).toBe(
      'cursor/grok-4.7:xhigh',
    );
    expect(parentModelArg({ id: 'grok-4.7', provider: 'cursor' }, 'off')).toBe('cursor/grok-4.7');
    expect(parentModelArg(undefined, 'high')).toBeUndefined();
    expect(resolvedCloudModel('auto', 'grok-4.7-xhigh')).toBe('grok-4.7-xhigh');
    expect(resolvedCloudModel('claude-opus-5-5-xhigh', 'grok-4.7-xhigh')).toBe(
      'claude-opus-5-5-xhigh',
    );
    expect(modelRejection('auto', ['grok-4.7-high'])).toBeUndefined();
    expect(modelRejection('grok-4.7-xhigh-fast', [])).toBeUndefined();
    expect(modelRejection('grok-4.7-xhigh-fast', ['grok-4.7-high'])).toContain('grok-4.7-high');
    expect(parseModelList('No models available\n')).toEqual([]);
    expect(parseModelList('cursor/grok-4.7-high\n')).toEqual(['grok-4.7-high']);
    expect(
      parseModelList(
        'provider  model  context\ncursor  grok-4.7-high  200K\nanthropic  claude-opus-5-5-xhigh  200K\n',
      ),
    ).toEqual(['grok-4.7-high', 'claude-opus-5-5-xhigh']);
    expect(await listInstalledModels('auto')).toEqual([]);
    expect(githubRepoUrl('git@github.com:yu-iskw/pi-cursor-plugin.git')).toBe(
      'https://github.com/yu-iskw/pi-cursor-plugin',
    );
    expect(githubRepoUrl('https://github.com/yu-iskw/pi-cursor-plugin')).toBe(
      'https://github.com/yu-iskw/pi-cursor-plugin',
    );
    expect(githubRepoUrl('https://gitlab.com/yu-iskw/pi-cursor-plugin')).toBeUndefined();
    expect(wantsCloud('local', 'main', '')).toBe(false);
    expect(wantsCloud('cloud', undefined, '')).toBe(true);
    expect(wantsCloud(undefined, 'main', '')).toBe(true);
    expect(wantsCloud(undefined, undefined, 'bc-agent')).toBe(true);
    expect(
      cloudReadiness({ apiKey: undefined, repoUrl: 'https://github.com/yu-iskw/pi-cursor-plugin' }),
    ).toBeUndefined();
    expect(
      cloudReadiness({
        apiKey: undefined,
        repoUrl: undefined,
        environment: 'cloud',
      }),
    ).toContain('CURSOR_API_KEY');
    expect(
      cloudReadiness({
        apiKey: 'cursor-key',
        repoUrl: undefined,
        environment: 'cloud',
      }),
    ).toContain('GitHub origin');
    expect(
      cloudReadiness({
        apiKey: 'cursor-key',
        repoUrl: 'https://github.com/yu-iskw/pi-cursor-plugin',
        environment: 'local',
        baseBranch: 'main',
      }),
    ).toContain('environment "cloud"');
    expect(
      cloudReadiness({
        apiKey: 'cursor-key',
        repoUrl: 'https://github.com/yu-iskw/pi-cursor-plugin',
        environment: 'pool',
        baseBranch: 'main',
      }),
    ).toContain('Rejected Task environment: pool');
  });

  it('routes cloud Task to the Cursor runtime and keeps local Task on Pi', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-task-'));
    const previousKey = process.env.CURSOR_API_KEY;
    const previousBin = process.env.PI_BIN;
    delete process.env.CURSOR_API_KEY;
    try {
      writePstack(home);
      const script = join(home, 'echo.mjs');
      writeFileSync(
        script,
        '#!/usr/bin/env node\nlet data="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>{data+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:data}))});\n',
      );
      chmodSync(script, 0o755);
      process.env.PI_BIN = script;
      const tools = new Map<string, RegisteredTool>();
      const pi = {
        registerTool(tool: RegisteredTool) {
          tools.set(tool.name, tool);
        },
      };
      registerCursorTools(pi as unknown as ExtensionAPI, () => {}, home);
      const task = tools.get('Task');
      if (!task) throw new Error('Task tool was not registered');
      const ctx = { cwd: home, hasUI: false } as ExtensionToolContext;
      await expect(
        task.execute(
          'cloud',
          {
            prompt: 'cover the loader',
            description: 'swarm',
            subagent_type: 'generalPurpose',
            environment: 'cloud',
            run_in_background: true,
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow('CURSOR_API_KEY');
      await expect(
        task.execute(
          'local-branch',
          {
            prompt: 'cover the loader',
            description: 'local',
            subagent_type: 'generalPurpose',
            environment: 'local',
            cloud_base_branch: 'main',
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow('environment "cloud"');
      const local = await task.execute(
        'local',
        {
          prompt: 'inspect the catalog',
          description: 'local explore',
          subagent_type: 'generalPurpose',
          readonly: true,
        },
        undefined,
        undefined,
        ctx,
      );
      const body = local.content.map((part) => part.text).join('\n');
      const parsed = JSON.parse(body.slice(body.indexOf('{'))) as { argv: string[]; stdin: string };
      expect(parsed.argv).toContain('--no-mcp');
      expect(parsed.argv).toContain('read,grep,find,ls');
      expect(parsed.stdin).toContain('Parent-provided poteto-mode SKILL.md path:');
      const inherited = await task.execute(
        'inherit',
        {
          prompt: 'inspect the catalog',
          description: 'inherit parent',
          subagent_type: 'generalPurpose',
          model: 'inherit-parent',
          readonly: true,
        },
        undefined,
        undefined,
        {
          cwd: home,
          hasUI: false,
          model: { id: 'grok-4.7', provider: 'cursor' },
          thinkingLevel: 'xhigh',
        } as ExtensionToolContext,
      );
      const inheritedBody = inherited.content.map((part) => part.text).join('\n');
      const inheritedArgs = JSON.parse(inheritedBody.slice(inheritedBody.indexOf('{'))) as {
        argv: string[];
      };
      expect(inheritedArgs.argv).toContain('--model');
      expect(inheritedArgs.argv).toContain('cursor/grok-4.7:xhigh');
    } finally {
      if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousKey;
      if (previousBin === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = previousBin;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('gives a concurrent writable Task its own git worktree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-wt-'));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const previousBin = process.env.PI_BIN;
    const previousRoot = process.env.PI_CURSOR_WORKTREE_ROOT;
    let isolated = '';
    try {
      writePstack(home);
      initGit(repo);
      const claim = join(home, 'claim');
      expect(claimWriter(claim)).toBe(true);
      expect(claimWriter(claim)).toBe(false);
      releaseWriter(claim);
      releaseWriter(claim);
      expect(() => rememberCheckout(home, '../evil', repo)).toThrow('Rejected resume id');
      await expect(createTaskWorktree(home, '../evil')).rejects.toThrow('Rejected resume id');
      await expect(createTaskWorktree(home, 'task-abcd1234')).rejects.toThrow(
        'not a git repository',
      );
      const script = join(home, 'cwd.cjs');
      writeFileSync(script, CWD_SCRIPT);
      chmodSync(script, 0o755);
      process.env.PI_BIN = script;
      process.env.PI_CURSOR_WORKTREE_ROOT = join(home, 'wt-root');
      const tools = new Map<string, RegisteredTool>();
      const pi = {
        registerTool(tool: RegisteredTool) {
          tools.set(tool.name, tool);
        },
      };
      registerCursorTools(pi as unknown as ExtensionAPI, () => {}, home);
      const task = tools.get('Task');
      if (!task) throw new Error('Task tool was not registered');
      const ctx = { cwd: repo, hasUI: false } as ExtensionToolContext;
      const background = await task.execute(
        'background',
        {
          prompt: 'edit the loader',
          description: 'background writer',
          subagent_type: 'generalPurpose',
          run_in_background: true,
        },
        undefined,
        undefined,
        ctx,
      );
      const backgroundText = background.content.map((part) => part.text).join('\n');
      expect(backgroundText).toContain(`Working directory: ${repo}`);
      const backgroundId = /Started background agent (task-[a-z0-9]+)/.exec(backgroundText)?.[1];
      if (!backgroundId) throw new Error('missing background agent id');
      const readOutput = tools.get('task_output')?.execute;
      if (!readOutput) throw new Error('task_output tool was not registered');
      await waitUntil(async () => {
        const record = await readOutput(
          'output',
          {
            prompt: '',
            description: '',
            subagent_type: 'generalPurpose',
            task_id: backgroundId,
          },
          undefined,
          undefined,
          ctx,
        );
        let finished = false;
        for (const part of record.content) {
          if (part.text.startsWith('done ') || part.text.startsWith('error ')) finished = true;
        }
        return finished;
      }, 'background writer did not finish');
      expect(claimWriter(repo)).toBe(true);
      await expect(
        task.execute(
          'busy',
          {
            prompt: 'resume the parent checkout',
            description: 'busy resume',
            subagent_type: 'generalPurpose',
            resume: 'task-parent1',
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow('in use by another Task');
      const reading = await task.execute(
        'read',
        {
          prompt: 'read the loader',
          description: 'readonly',
          subagent_type: 'generalPurpose',
          readonly: true,
        },
        undefined,
        undefined,
        ctx,
      );
      expect(cwdFrom(reading.content.map((part) => part.text).join('\n'))).toBe(repo);
      const writing = await task.execute(
        'write',
        {
          prompt: 'edit the loader too',
          description: 'second writer',
          subagent_type: 'generalPurpose',
        },
        undefined,
        undefined,
        ctx,
      );
      const writingText = writing.content.map((part) => part.text).join('\n');
      isolated = cwdFrom(writingText);
      expect(isolated.startsWith(join(home, 'wt-root'))).toBe(true);
      expect(isolated).not.toBe(repo);
      expect(git(['branch', '--show-current'], isolated).startsWith('pstack/task-')).toBe(true);
      const agentId = /Agent id: (task-[a-z0-9]+)/.exec(writingText)?.[1];
      if (!agentId) throw new Error('missing agent id');
      writeFileSync(join(home, 'tasks', 'sessions', `${agentId}.jsonl`), `{"id":"${agentId}"}\n`);
      releaseWriter(repo);
      const resumed = await task.execute(
        'resume',
        {
          prompt: 'continue in the same checkout',
          description: 'resume writer',
          subagent_type: 'generalPurpose',
          resume: agentId,
        },
        undefined,
        undefined,
        ctx,
      );
      expect(cwdFrom(resumed.content.map((part) => part.text).join('\n'))).toBe(isolated);
      const third = await task.execute(
        'third',
        {
          prompt: 'edit after the other writer finished',
          description: 'third writer',
          subagent_type: 'generalPurpose',
        },
        undefined,
        undefined,
        ctx,
      );
      expect(cwdFrom(third.content.map((part) => part.text).join('\n'))).toBe(repo);
    } finally {
      releaseWriter(repo);
      if (previousBin === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = previousBin;
      if (previousRoot === undefined) delete process.env.PI_CURSOR_WORKTREE_ROOT;
      else process.env.PI_CURSOR_WORKTREE_ROOT = previousRoot;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lists Cursor MCP servers for why and reflect', () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-mcp-'));
    try {
      writePstack(home);
      writePluginMcp(home, 'docs', true, {
        notion: { url: 'https://mcp.example/notion', description: 'Long-form documents' },
      });
      writePluginMcp(home, 'off', false, {
        sentry: { url: 'https://mcp.example/sentry', description: 'Error tracking' },
      });
      const userFile = join(home, 'user-mcp.json');
      writeFileSync(
        userFile,
        JSON.stringify({
          mcpServers: {
            slack: {
              url: 'https://mcp.slack.com/mcp',
              description: 'Real-time team chat',
              auth: { CLIENT_ID: 'cursor-only' },
            },
            google: { auth: { CLIENT_ID: 'x' } },
            '../evil': { command: 'echo' },
          },
        }),
      );
      mkdirSync(join(home, '.cursor'), { recursive: true });
      writeFileSync(
        join(home, '.cursor', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            local: {
              command: 'echo',
              args: ['hi'],
              env: { TOKEN: 'secret' },
              cwd: home,
              description: 'Local notes',
            },
            slack: { url: 'https://project.example/slack', description: 'Project chat override' },
          },
        }),
      );
      const hidden = cursorMcpServers({ home, cwd: home, userFile });
      expect(hidden.map((server) => server.name)).toEqual(['slack', 'notion']);
      expect(hidden.find((server) => server.name === 'slack')?.config).toEqual({
        url: 'https://mcp.slack.com/mcp',
      });
      const servers = cursorMcpServers({ home, cwd: home, userFile, projectTrusted: true });
      expect(servers.map((server) => server.name)).toEqual(['slack', 'local', 'notion']);
      const slack = servers.find((server) => server.name === 'slack');
      expect(slack?.config).toEqual({ url: 'https://project.example/slack' });
      expect(JSON.stringify(slack?.config)).not.toContain('CLIENT_ID');
      const local = servers.find((server) => server.name === 'local');
      expect(local?.config).toEqual({
        command: 'echo',
        args: ['hi'],
        env: { TOKEN: 'secret' },
        cwd: home,
      });
      const directory = mcpCatalogDir(home);
      writeMcpCatalog(directory, servers);
      expect(readFileSync(join(directory, 'notion', 'INSTRUCTIONS.md'), 'utf8')).toContain(
        'Long-form documents',
      );
      writeMcpCatalog(
        directory,
        servers.filter((server) => server.name !== 'slack'),
      );
      expect(existsSync(join(directory, 'slack'))).toBe(false);
      const listed = formatMcpMessage(directory, servers);
      expect(listed).toContain(directory);
      expect(listed).toContain('Project chat override');
      expect(formatMcpMessage(directory, [])).toContain('gap');
      const disabled = formatMcpMessage(directory, [], { readonlyDisabled: true });
      expect(disabled).toContain('readonly');
      expect(disabled).not.toContain('gap');
      expect(disabled).not.toContain('No Cursor MCP servers are configured');
      const doctor = dispatchCursorPlugin('doctor pstack', {
        home,
        cwd: home,
        userRulesDir: join(home, 'empty-rules'),
        projectTrusted: true,
      });
      expect(doctor.message).toContain('mcp: ');
      expect(doctor.message).toContain('local');
      const untrustedDoctor = dispatchCursorPlugin('doctor pstack', {
        home,
        cwd: home,
        userRulesDir: join(home, 'empty-rules'),
      });
      expect(untrustedDoctor.message).not.toMatch(/mcp:.*local/);
      expect(doctor.message).toContain('notion');
      expect(doctor.message).not.toContain('sentry');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('pstack review follow-ups', () => {
  it('splits Cursor globs and replaces the plugin prompt section', () => {
    const parsed = parseFrontmatter(
      '---\nglobs: *.ts,*.tsx\npaths:\n  - "src/**/*.ts"\n  - "lib/**/*.ts"\n---\nUSE_EXACT_TYPES\n',
    );
    expect(frontmatterList(parsed.data, 'globs')).toEqual(['*.ts', '*.tsx']);
    expect(frontmatterList(parsed.data, 'paths')).toEqual(['src/**/*.ts', 'lib/**/*.ts']);
    expect(frontmatterList(new Map([['globs', '{src,lib}/**/*.ts']]), 'globs')).toEqual([
      '{src,lib}/**/*.ts',
    ]);
    const home = mkdtempSync(join(tmpdir(), 'pstack-globs-'));
    try {
      mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });
      writeFileSync(
        join(home, '.cursor', 'rules', 'types.mdc'),
        '---\ndescription: ts\nglobs: **/*.ts,**/*.tsx\n---\nUSE_EXACT_TYPES\n',
      );
      const hidden = loadRules({ home, cwd: home, userRulesDir: join(home, 'none') });
      expect(formatRuleMessage(hidden, [], ['src/app.ts'])).not.toContain('USE_EXACT_TYPES');
      const rules = loadRules({
        home,
        cwd: home,
        userRulesDir: join(home, 'none'),
        projectTrusted: true,
      });
      expect(formatRuleMessage(rules, [], ['src/app.ts'])).toContain('USE_EXACT_TYPES');
      expect(formatRuleMessage(rules, [], ['README.md'])).not.toContain('USE_EXACT_TYPES');
      expect(globMatches('*.ts', 'src/app.ts')).toBe(true);
      expect(globMatches('*.ts', 'src/app.tsx')).toBe(false);
      expect(globMatches('{src,lib}/**/*.ts', 'lib/app.ts')).toBe(true);
      expect(globMatches('src/*.ts', 'src/nested/app.ts')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const replaced = replaceSection(replaceSection('base prompt', 'rules one'), 'rules two');
    expect(replaced).toContain('base prompt');
    expect(replaced).toContain('rules two');
    expect(replaced).not.toContain('rules one');
  });

  it('rejects a cloud Task that cannot start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-cloud-gate-'));
    const previousDepth = process.env.PI_CURSOR_TASK_DEPTH;
    try {
      writePstack(home);
      const tools = new Map<string, RegisteredTool>();
      const pi = {
        registerTool(tool: RegisteredTool) {
          tools.set(tool.name, tool);
        },
      };
      registerCursorTools(pi as unknown as ExtensionAPI, () => {}, home);
      const task = tools.get('Task');
      if (!task) throw new Error('Task tool was not registered');
      const ctx = { cwd: home, hasUI: false } as ExtensionToolContext;
      await expect(
        task.execute(
          'unknown',
          {
            prompt: 'look around',
            description: 'unknown cloud agent',
            subagent_type: 'not-an-agent',
            environment: 'cloud',
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow('Unknown subagent_type');
      process.env.PI_CURSOR_TASK_DEPTH = '4';
      await expect(
        task.execute(
          'deep',
          {
            prompt: 'look around',
            description: 'too deep',
            subagent_type: 'generalPurpose',
            environment: 'cloud',
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow('exceeds');
      await expect(
        startCloudTask({
          prompt: 'stop',
          readonly: true,
          cwd: home,
          environment: 'cloud',
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow('Task aborted.');
    } finally {
      if (previousDepth === undefined) delete process.env.PI_CURSOR_TASK_DEPTH;
      else process.env.PI_CURSOR_TASK_DEPTH = previousDepth;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('publishes a Cursor transcript the pstack skills can read', () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-transcripts-'));
    try {
      expect(projectSlug('/Users/you/proj')).toBe('Users-you-proj');
      expect(projectSlug('/workspace')).toBe('workspace');
      const transcripts = join(home, '.cursor', 'projects', 'Users-you-proj', 'agent-transcripts');
      const context = formatWorkspaceContext({
        cwd: '/Users/you/proj',
        sessionId: 'task-live01',
        homeDir: home,
      });
      expect(context).toContain(`Agent transcripts for this workspace live in ${transcripts}.`);
      expect(context).toContain(
        `The current agent's store is ${join(home, '.cursor', 'projects', 'Users-you-proj')}.`,
      );
      expect(context).toContain(join(transcripts, 'task-live01', 'task-live01.jsonl'));
      const session = join(home, 'session.jsonl');
      writeFileSync(
        session,
        [
          JSON.stringify({ type: 'session', version: 3, id: 'task-live01' }),
          JSON.stringify({
            type: 'message',
            message: { role: 'user', content: 'why is this here' },
          }),
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/app.ts' } }],
            },
          }),
          JSON.stringify({
            type: 'message',
            message: { role: 'system', content: 'hidden prompt' },
          }),
        ].join('\n'),
      );
      const written = publishCursorTranscript({
        cwd: '/Users/you/proj',
        sessionId: 'task-live01',
        sessionFile: session,
        prompt: 'why is this here',
        homeDir: home,
        parentTranscripts: transcripts,
        parentSessionId: 'parent-session1',
      });
      expect(written).toBe(join(transcripts, 'task-live01', 'task-live01.jsonl'));
      const body = readFileSync(written ?? '', 'utf8')
        .trim()
        .split('\n');
      expect(body).toHaveLength(2);
      const first = JSON.parse(body[0] ?? '{}') as {
        message: { content: { text: string }[] };
      };
      expect(first.message.content[0]?.text).toBe('why is this here');
      expect(body[1]).toContain('src/app.ts');
      expect(body.join('\n')).not.toContain('hidden prompt');
      expect(
        readFileSync(
          join(transcripts, 'parent-session1', 'subagents', 'task-live01.jsonl'),
          'utf8',
        ),
      ).toContain('why is this here');
      expect(
        publishCursorTranscript({
          cwd: '/Users/you/proj',
          sessionId: '../etc',
          sessionFile: session,
          homeDir: home,
        }),
      ).toBeUndefined();
      const plan = planTask(
        {
          ...blankRequest(home),
          parentTranscripts: transcripts,
          parentSessionId: 'parent-session1',
        },
        [],
        [],
      );
      if (!('launch' in plan)) throw new Error(plan.error);
      expect(plan.launch.env.PI_CURSOR_PARENT_TRANSCRIPTS).toBe(transcripts);
      expect(plan.launch.env.PI_CURSOR_PARENT_SESSION).toBe('parent-session1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('publishes a worktree Task transcript into the parent workspace', () => {
    const home = mkdtempSync(join(tmpdir(), 'pstack-worktree-transcript-'));
    try {
      const parent = join(home, '.cursor', 'projects', 'workspace', 'agent-transcripts');
      const worktree = join(home, '.cursor', 'worktrees', 'workspace', 'task-child1');
      const session = join(home, 'session.jsonl');
      writeFileSync(
        session,
        `${JSON.stringify({
          type: 'message',
          message: { role: 'user', content: 'worktree note' },
        })}\n`,
      );
      const written = publishCursorTranscript({
        cwd: worktree,
        sessionId: 'task-child1',
        sessionFile: session,
        homeDir: home,
        parentTranscripts: parent,
        parentSessionId: 'parent01',
      });
      expect(written).toBe(join(parent, 'task-child1', 'task-child1.jsonl'));
      expect(existsSync(join(home, '.cursor', 'projects', projectSlug(worktree)))).toBe(false);
      expect(
        readFileSync(join(parent, 'parent01', 'subagents', 'task-child1.jsonl'), 'utf8'),
      ).toContain('worktree note');
      const context = formatWorkspaceContext({
        cwd: worktree,
        sessionId: 'task-child1',
        homeDir: home,
        parentTranscripts: parent,
      });
      expect(context).toContain(parent);
      expect(context).toContain(join(parent, 'task-child1', 'task-child1.jsonl'));
      expect(context).not.toContain(projectSlug(worktree));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts a Cursor AskQuestion prompt', () => {
    const formatted = formatAskWithoutUi(
      normalizeQuestions({
        title: 'Setup',
        questions: [
          {
            id: 'budget',
            prompt: 'Which budget?',
            options: [{ id: 'large', label: 'large — xhigh reasoning' }],
          },
        ],
      }),
    );
    expect(formatted).toContain('Setup: Which budget?');
    expect(formatted).toContain('large — xhigh reasoning');
  });

  it('keeps the TodoWrite list for later turns', async () => {
    expect(formatTodoMessage([])).toBe('');
    const home = mkdtempSync(join(tmpdir(), 'pstack-todos-'));
    try {
      const tools = new Map<string, TodoTool>();
      const pi = {
        registerTool(tool: TodoTool) {
          tools.set(tool.name, tool);
        },
      };
      const session = registerCursorTools(pi as unknown as ExtensionAPI, () => {}, home, home);
      const todo = tools.get('TodoWrite');
      if (!todo) throw new Error('TodoWrite was not registered');
      const shown: Array<string[] | undefined> = [];
      const ctx = {
        cwd: home,
        hasUI: true,
        ui: {
          setWidget(_key: string, content: string[] | undefined) {
            shown.push(content);
          },
        },
        sessionManager: {
          getSessionId: () => 'task-todo01',
        },
      } as ExtensionToolContext;
      const written = await todo.execute(
        'todo-1',
        {
          merge: false,
          todos: [{ id: 'playbook', content: 'copy the steps', status: 'pending' }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(written.content[0]?.text).toContain('[ ] playbook: copy the steps');
      expect(formatTodoMessage(session.current())).toContain('# Session todos');
      expect(formatTodoMessage(session.current())).toContain('copy the steps');
      expect(shown[0]?.join('\n')).toContain('copy the steps');
      const stored = sessionTodoFile(home, 'task-todo01', home);
      expect(readFileSync(stored ?? '', 'utf8')).toContain('copy the steps');
      const resumed = registerCursorTools(pi as unknown as ExtensionAPI, () => {}, home, home);
      resumed.sync(ctx);
      expect(formatTodoMessage(resumed.current())).toContain('copy the steps');
      const other = { ...ctx, sessionManager: { getSessionId: () => 'task-todo02' } };
      resumed.sync(other as ExtensionToolContext);
      expect(formatTodoMessage(resumed.current())).toBe('');
      const escaped = {
        ...ctx,
        sessionManager: { getSessionId: () => '../etc' },
      } as ExtensionToolContext;
      await todo.execute(
        'todo-2',
        { merge: false, todos: [{ id: 'nope', content: 'escape', status: 'pending' }] },
        undefined,
        undefined,
        escaped,
      );
      expect(sessionTodoFile(home, '../etc', home)).toBeUndefined();
      session.reset();
      expect(formatTodoMessage(session.current())).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

interface TodoTool {
  name: string;
  execute: (
    toolCallId: string,
    params: {
      merge: boolean;
      todos: { id: string; content: string; status: 'pending' }[];
    },
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionToolContext,
  ) => Promise<{ content: { text?: string }[] }>;
}

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: {
      prompt: string;
      description: string;
      subagent_type: string;
      model?: string;
      readonly?: boolean;
      run_in_background?: boolean;
      resume?: string;
      task_id?: string;
      environment?: string;
      cloud_base_branch?: string;
    },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionToolContext,
  ) => Promise<{ content: { type: string; text: string }[] }>;
}

const CWD_SCRIPT = `#!/usr/bin/env node
const chunks = [];
let ended = false;
function finish() {
  if (ended) return;
  ended = true;
  process.stdout.write(
    JSON.stringify({ cwd: process.cwd(), stdin: Buffer.concat(chunks).toString('utf8') }),
  );
}
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', finish);
process.stdin.resume();
if (process.stdin.readableEnded) finish();
`;

function initGit(repo: string): void {
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['commit', '--allow-empty', '-m', 'init'], repo);
}

async function waitUntil(ready: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

function cwdFrom(text: string): string {
  const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { cwd: string };
  return parsed.cwd;
}

function blankRequest(cwd: string) {
  return {
    prompt: 'work',
    description: 'work',
    subagentType: 'generalPurpose',
    readonly: false,
    cwd,
    depth: 0,
    sessionId: 'task-blank01',
    sessionDir: join(cwd, 'tasks', 'sessions'),
    resume: false,
  };
}
