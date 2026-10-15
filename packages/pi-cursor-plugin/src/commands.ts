import { basename } from 'node:path';

import { formatDoctor, loadCatalog, loadRules } from './catalog.js';
import {
  addMarketplace,
  inspect,
  install,
  loadRegistry,
  resolvePlugin,
  setEnabled,
  uninstall,
} from './manager.js';

import type { InstalledPlugin } from './manager.js';

export interface CommandContext {
  home: string;
  cwd: string;
  userRulesDir: string;
}

export interface DispatchResult {
  message: string;
  reload: boolean;
}

const USAGE =
  'Usage: /cursor-plugin [marketplace add|marketplace list|install|update|uninstall|enable|disable|list|inspect|doctor|skills]';

type Handler = (value: string, context: CommandContext) => DispatchResult;

function requireValue(value: string, usage: string): string {
  const name = value.trim();
  if (!name) throw new Error(usage);
  return name;
}

function findPlugin(home: string, name: string): InstalledPlugin {
  const plugin = Object.values(loadRegistry(home).plugins).find((entry) => entry.name === name);
  if (!plugin) throw new Error('Plugin not installed: ' + name);
  return plugin;
}

function listPlugins(_value: string, context: CommandContext): DispatchResult {
  const entries = Object.values(loadRegistry(context.home).plugins);
  const message = entries.length
    ? entries
        .map((plugin) => {
          const version = plugin.manifest.version || 'unversioned';
          const state = plugin.enabled ? 'enabled' : 'disabled';
          return `${plugin.name} ${version} ${state}`;
        })
        .join('\n')
    : 'No plugins installed';
  return { message, reload: false };
}

function marketplaceCommand(args: string[], context: CommandContext): DispatchResult {
  if (args[0] === 'add' && args[1]) {
    const source = args[1];
    const name = args[2] || basename(source);
    addMarketplace(name, source, context.home);
    return { message: `Marketplace ${name} registered: ${source}`, reload: false };
  }
  if (args[0] === 'list') {
    return {
      message: JSON.stringify(loadRegistry(context.home).marketplaces, null, 2),
      reload: false,
    };
  }
  return {
    message: 'Usage: /cursor-plugin marketplace add github:owner/repo [name] | marketplace list',
    reload: false,
  };
}

function installPlugin(value: string, context: CommandContext): DispatchResult {
  const spec = requireValue(value, 'Usage: /cursor-plugin install <spec>');
  const installed = install(resolvePlugin(spec, context.home), context.home);
  return {
    message: `Installed ${installed.name} at ${installed.revision.slice(0, 12)}.`,
    reload: true,
  };
}

function updatePlugin(value: string, context: CommandContext): DispatchResult {
  const plugin = findPlugin(
    context.home,
    requireValue(value, 'Usage: /cursor-plugin update <name>'),
  );
  const updated = install(plugin.source, context.home);
  return { message: `Updated ${updated.name}.`, reload: true };
}

function uninstallPlugin(value: string, context: CommandContext): DispatchResult {
  const name = requireValue(value, 'Usage: /cursor-plugin uninstall <name>');
  uninstall(name, context.home);
  return { message: `Uninstalled ${name}.`, reload: true };
}

function setPluginEnabled(enabled: boolean): Handler {
  return (value, context) => {
    const name = requireValue(
      value,
      `Usage: /cursor-plugin ${enabled ? 'enable' : 'disable'} <name>`,
    );
    setEnabled(name, enabled, context.home);
    return { message: `${name} ${enabled ? 'enabled' : 'disabled'}.`, reload: true };
  };
}

function inspectPlugin(value: string, context: CommandContext): DispatchResult {
  const name = requireValue(value, 'Usage: /cursor-plugin inspect <name>');
  return { message: JSON.stringify(inspect(name, context.home), null, 2), reload: false };
}

function doctorPlugin(value: string, context: CommandContext): DispatchResult {
  const name = requireValue(value, 'Usage: /cursor-plugin doctor <name>');
  findPlugin(context.home, name);
  const message = formatDoctor(
    name,
    loadCatalog(context.home),
    loadRules({ home: context.home, cwd: context.cwd, userRulesDir: context.userRulesDir }),
  );
  return { message, reload: false };
}

function listSkillCommands(_value: string, context: CommandContext): DispatchResult {
  const skills = loadCatalog(context.home).skills;
  const message = skills.length
    ? skills
        .map((skill) => {
          const mode = skill.disableModelInvocation ? 'manual' : 'model';
          return `/${skill.commandName} (${skill.plugin}, ${mode}) ${skill.filePath}`;
        })
        .join('\n')
    : 'No enabled skills';
  return { message, reload: false };
}

const COMMANDS = new Map<string, Handler>([
  ['list', listPlugins],
  ['install', installPlugin],
  ['update', updatePlugin],
  ['uninstall', uninstallPlugin],
  ['enable', setPluginEnabled(true)],
  ['disable', setPluginEnabled(false)],
  ['inspect', inspectPlugin],
  ['doctor', doctorPlugin],
  ['skills', listSkillCommands],
]);

export function dispatchCursorPlugin(input: string, context: CommandContext): DispatchResult {
  const [operation = '', ...rest] = input.trim().split(/\s+/);
  if (operation === 'marketplace') return marketplaceCommand(rest, context);
  const handler = COMMANDS.get(operation);
  if (!handler) return { message: USAGE, reload: false };
  return handler(rest.join(' '), context);
}
