import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  formatRuleMessage,
  replaceSection,
  loadCatalog,
  loadRules,
  pathsInText,
  skillInvocation,
  toolPaths,
} from './catalog.js';
import { dispatchCursorPlugin } from './commands.js';
import { formatTodoMessage } from './cursor-actions.js';
import { storeRoot } from './manager.js';
import {
  cursorMcpServers,
  formatMcpMessage,
  mcpCatalogDir,
  writeMcpCatalog,
} from './mcp-catalog.js';
import { registerCursorTools } from './register-tools.js';
import {
  formatWorkspaceContext,
  publishCursorTranscript,
  sessionIdentity,
} from './workspace-context.js';

import type { CursorMcpServer } from './mcp-catalog.js';
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
  const sessionTodos = registerCursorTools(
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
          projectTrusted: ctx.isProjectTrusted(),
        });
        report(ctx, result.message);
        if (result.reload) await ctx.reload();
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  registerSkillCommands(pi, home);
  const touchedFiles = new Set<string>();
  pi.on('tool_call', (event) => {
    for (const file of toolPaths(event.toolName, event.input)) touchedFiles.add(file);
  });
  pi.on('resources_discover', () => {
    const catalog = loadCatalog(home);
    return { skillPaths: catalog.skillPaths, promptPaths: catalog.promptPaths };
  });
  const registeredMcp = new Set<string>();
  const syncMcp = (cwd: string, projectTrusted: boolean): CursorMcpServer[] => {
    if (process.argv.includes('--no-mcp')) return [];
    const servers = cursorMcpServers({ home, cwd, projectTrusted });
    const connected = servers.filter((server) => registerServer(pi, server, registeredMcp));
    writeMcpCatalog(mcpCatalogDir(home), connected);
    return connected;
  };
  syncMcp(process.cwd(), false);
  pi.on('session_start', (_event, ctx) => {
    touchedFiles.clear();
    sessionTodos.sync(ctx);
    syncMcp(ctx.cwd, ctx.isProjectTrusted());
    publishLiveSession(ctx, '');
  });
  pi.on('before_agent_start', (event, ctx) => {
    sessionTodos.sync(ctx);
    const prompt = userPrompt(event);
    const session = publishLiveSession(ctx, prompt);
    const readonlyDisabled = process.argv.includes('--no-mcp');
    const servers = syncMcp(ctx.cwd, ctx.isProjectTrusted());
    const text = [
      formatRuleMessage(
        loadRules({
          home,
          cwd: ctx.cwd,
          userRulesDir: userRulesDir(),
          projectTrusted: ctx.isProjectTrusted(),
        }),
        loadCatalog(home).skills,
        [...pathsInText(prompt), ...touchedFiles],
      ),
      formatMcpMessage(mcpCatalogDir(home), servers, { readonlyDisabled }),
      formatWorkspaceContext({
        cwd: ctx.cwd,
        sessionId: session.id,
        parentTranscripts: process.env.PI_CURSOR_PARENT_TRANSCRIPTS,
      }),
      formatTodoMessage(sessionTodos.current()),
    ]
      .filter((section) => section.trim().length > 0)
      .join('\n\n');
    event.systemPromptOptions.appendSystemPrompt = replaceSection(
      event.systemPromptOptions.appendSystemPrompt,
      text,
    );
  });
}

function publishLiveSession(ctx: { cwd: string }, prompt: string): { id?: string } {
  const session = sessionIdentity(ctx);
  if (!session.id) return {};
  publishCursorTranscript({
    cwd: ctx.cwd,
    sessionId: session.id,
    sessionFile: session.file,
    prompt,
    parentTranscripts: process.env.PI_CURSOR_PARENT_TRANSCRIPTS,
    parentSessionId: process.env.PI_CURSOR_PARENT_SESSION,
  });
  return { id: session.id };
}

function registerServer(
  pi: ExtensionAPI,
  server: CursorMcpServer,
  registered: Set<string>,
): boolean {
  if (registered.has(server.name)) return true;
  try {
    pi.registerMcpServer(server.name, server.config);
    registered.add(server.name);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('already')) return false;
    registered.add(server.name);
    return true;
  }
}
