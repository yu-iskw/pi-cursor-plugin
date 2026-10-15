import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  skillInvocation,
} from './catalog.js';
import { dispatchCursorPlugin } from './commands.js';
import {
  applyTodos,
  formatAskWithoutUi,
  formatTodos,
  normalizeQuestions,
} from './cursor-actions.js';
import { parseFrontmatter } from './frontmatter.js';
import { saveRegistry } from './manager.js';
import { findSession, planTask, runSubagent, shouldBackground } from './subagent.js';

import type { InstalledPlugin } from './manager.js';

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
      const rules = loadRules({ home, cwd, userRulesDir: userRules });
      const formatted = formatRuleMessage(rules, loadCatalog(home).skills);
      expect(formatted).toContain('Always use the local marker.');
      expect(formatted).toContain('requestable note');
      expect(formatted).not.toContain('SECRET_RULE_BODY');
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
      expect('error' in cloud && cloud.error.includes('Respawn with environment "local"')).toBe(
        true,
      );
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
    ).toEqual({ question: 'Areas?', options: ['style'], allowMultiple: true });
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
});

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
