import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  appendSection,
  formatRuleMessage,
  loadCatalog,
  loadRules,
  pathsInText,
  skillInvocation,
} from './catalog.js';
import { dispatchCursorPlugin } from './commands.js';
import { storeRoot } from './manager.js';
import { registerCursorTools } from './register-tools.js';

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const PI_COMMANDS = [
  'settings',
  'model',
  'tree',
  'thinking',
  'scoped-models',
  'export',
  'import',
  'share',
  'bug',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit',
  'cursor-plugin',
];

function userRulesDir(): string {
  return join(homedir(), '.cursor', 'rules');
}

function userPrompt(
  event: { messageType: 'user'; prompt: string } | { messageType: 'custom' },
): string {
  switch (event.messageType) {
    case 'user':
      return event.prompt;
    case 'custom':
      return '';
    default: {
      const unexpected: never = event;
      throw new Error(String(unexpected));
    }
  }
}

function report(
  ctx: ExtensionCommandContext,
  message: string,
  level: 'info' | 'error' = 'info',
): void {
  if (ctx.mode === 'print' || ctx.mode === 'json') console.error(message);
  ctx.ui.notify(message, level);
}

function registerSkillCommands(pi: ExtensionAPI, home: string): void {
  const reserved = new Set(PI_COMMANDS);
  for (const skill of loadCatalog(home).skills) {
    if (!skill.commandName || reserved.has(skill.commandName)) continue;
    reserved.add(skill.commandName);
    pi.registerCommand(skill.commandName, {
      description: (skill.description || `Cursor skill ${skill.commandName}`).slice(0, 200),
      handler: async (args, ctx) => {
        try {
          await Promise.resolve(pi.sendUserMessage(skillInvocation(skill, args)));
        } catch (error) {
          report(ctx, error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}

export default function (pi: ExtensionAPI): void {
  const home = storeRoot();
  registerCursorTools(
    pi,
    (message) => {
      pi.sendUserMessage(message, { deliverAs: 'followUp' });
    },
    home,
  );
  pi.registerCommand('cursor-plugin', {
    description:
      'Manage Cursor-compatible plugins: marketplace, install, list, inspect, doctor, enable, disable, update, uninstall, skills',
    handler: async (input, ctx) => {
      try {
        const result = dispatchCursorPlugin(input, {
          home,
          cwd: ctx.cwd,
          userRulesDir: userRulesDir(),
        });
        report(ctx, result.message);
        if (result.reload) await ctx.reload();
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  registerSkillCommands(pi, home);
  pi.on('resources_discover', () => {
    const catalog = loadCatalog(home);
    return { skillPaths: catalog.skillPaths, promptPaths: catalog.promptPaths };
  });
  pi.on('before_agent_start', (event, ctx) => {
    const prompt = userPrompt(event);
    const text = formatRuleMessage(
      loadRules({ home, cwd: ctx.cwd, userRulesDir: userRulesDir() }),
      loadCatalog(home).skills,
      pathsInText(prompt),
    );
    event.systemPromptOptions.appendSystemPrompt = appendSection(
      event.systemPromptOptions.appendSystemPrompt,
      text,
    );
  });
}
