import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve, relative, sep, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export type PluginFormat = "cursor" | "agent";
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  skills?: string;
  agents?: string;
  commands?: string;
  rules?: string;
  hooks?: string;
  mcpServers?: string;
  [key: string]: unknown;
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
export interface PluginRegistry { schemaVersion: 1; plugins: Record<string, InstalledPlugin>; marketplaces: Record<string, string>; }
export interface PluginCapability { name: string; available: boolean; detail: string; }

export function storeRoot(): string {
  return process.env.PI_CURSOR_PLUGIN_HOME || join(homedir(), ".pi", "cursor-plugin");
}
const empty = (): PluginRegistry => ({ schemaVersion: 1, plugins: {}, marketplaces: {} });
export function loadRegistry(root = storeRoot()): PluginRegistry {
  const file = join(root, "registry.json");
  if (!existsSync(file)) return empty();
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || (value as PluginRegistry).schemaVersion !== 1) throw new Error("Invalid plugin registry");
  return value as PluginRegistry;
}
export function saveRegistry(value: PluginRegistry, root = storeRoot()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, "registry.json.tmp");
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const { renameSync } = requireFs();
  renameSync(tmp, join(root, "registry.json"));
}
function requireFs() { return { renameSync: (a: string, b: string) => { const fs = requireRename(); fs(a, b); } }; }
function requireRename() { return renameSync; }
import { renameSync } from "node:fs";
export function safeJoin(root: string, part: string): string {
  if (!part || part.startsWith("/") || part.includes("\\") || part.split("/").some(x => x === "..")) throw new Error("Unsafe relative path: " + part);
  const base = resolve(root);
  const target = resolve(base, part);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Path escapes plugin root");
  return target;
}
export function readManifest(root: string): { format: PluginFormat; manifest: PluginManifest } {
  const cursor = join(root, ".cursor-plugin", "plugin.json");
  const agent = join(root, "plugin.json");
  const file = existsSync(cursor) ? cursor : agent;
  if (!existsSync(file)) throw new Error("No supported plugin manifest in " + root);
  const obj: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Invalid plugin manifest");
  const manifest = obj as PluginManifest;
  if (typeof manifest.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.name)) throw new Error("Invalid plugin name");
  for (const property of ["skills", "agents", "rules", "commands", "hooks", "mcpServers"] as const) {
    if (manifest[property] !== undefined && typeof manifest[property] !== "string") throw new Error("Unsupported " + property + " manifest field");
  }
  return { format: file === cursor ? "cursor" : "agent", manifest };
}
export function componentPaths(root: string, manifest: PluginManifest, key: "skills" | "agents" | "rules" | "commands"): string[] {
  const configured = manifest[key];
  const directory = safeJoin(root, typeof configured === "string" ? configured : key);
  if (!existsSync(directory)) return [];
  const results: string[] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && (key === "skills" ? entry.name === "SKILL.md" : /\.mdc?$/.test(entry.name))) results.push(file);
    }
  }
  walk(directory);
  return results.sort();
}
export function parseSource(input: string): { repo: string; subdir: string; ref?: string } {
  const github = input.replace(/^github:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const parts = github.split("/").filter(Boolean);
  if (parts.length < 2 || !parts.slice(0, 2).every(x => /^[\w.-]+$/.test(x))) throw new Error("Expected github:owner/repo[/plugin] or GitHub URL");
  if (parts[2] === "tree" && parts.length >= 4) return { repo: parts.slice(0, 2).join("/"), ref: parts[3], subdir: parts.slice(4).join("/") };
  return { repo: parts.slice(0, 2).join("/"), subdir: parts.slice(2).join("/") };
}
export function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 * 8 });
  if (result.status !== 0) throw new Error("git failed: " + (result.stderr || result.error?.message || args.join(" ")));
  return result.stdout.trim();
}
export function install(source: string, home = storeRoot()): InstalledPlugin {
  const { repo, subdir, ref } = parseSource(source);
  const root = join(home, "cache");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, "download-" + process.pid + "-" + Date.now());
  try {
    git(["clone", "--filter=blob:none", "--no-checkout", "https://github.com/" + repo + ".git", tmp]);
    git(["checkout", ref || "HEAD"], tmp);
    const revision = git(["rev-parse", "HEAD"], tmp);
    const path = subdir ? safeJoin(tmp, subdir) : tmp;
    const { format, manifest } = readManifest(path);
    const registry = loadRegistry(home);
    const target = join(home, "plugins", manifest.name);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(join(home, "plugins"), { recursive: true });
    cpSync(path, target, { recursive: true, filter: item => !item.split(sep).includes(".git") });
    const entry: InstalledPlugin = {
      name: manifest.name, source, sourcePath: subdir, revision, format, manifest,
      enabled: true, installedAt: new Date().toISOString()
    };
    registry.plugins[manifest.name] = entry;
    saveRegistry(registry, home);
    return entry;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
export function uninstall(name: string, home = storeRoot()): void {
  const registry = loadRegistry(home);
  if (!registry.plugins[name]) throw new Error("Plugin not installed: " + name);
  rmSync(join(home, "plugins", name), { recursive: true, force: true });
  delete registry.plugins[name];
  saveRegistry(registry, home);
}
export function setEnabled(name: string, enabled: boolean, home = storeRoot()): void {
  const registry = loadRegistry(home);
  if (!registry.plugins[name]) throw new Error("Plugin not installed: " + name);
  registry.plugins[name].enabled = enabled;
  saveRegistry(registry, home);
}
export function inspect(name: string, home = storeRoot()): { entry: InstalledPlugin; capabilities: PluginCapability[] } {
  const entry = loadRegistry(home).plugins[name];
  if (!entry) throw new Error("Plugin not installed: " + name);
  const root = join(home, "plugins", name);
  const capabilities = (["skills", "commands", "agents", "rules"] as const).map(key => ({
    name: key, available: componentPaths(root, entry.manifest, key).length > 0,
    detail: key === "skills" ? "Skill files discovered; Pi can load them after /reload" :
      key === "commands" ? "Markdown commands discovered; dynamic registration requires reload" :
      "Detected but full Cursor runtime semantics are not implemented"
  }));
  capabilities.push({ name: "hooks", available: false, detail: "Execution deliberately disabled pending verified lifecycle mapping" });
  capabilities.push({ name: "mcp", available: false, detail: "MCP configuration is not automatically executed" });
  return { entry, capabilities };
}
export function listSkills(home = storeRoot()): { plugin: string; path: string; name: string }[] {
  const registry = loadRegistry(home);
  return Object.values(registry.plugins).filter(x => x.enabled).flatMap(entry => {
    const root = join(home, "plugins", entry.name);
    return componentPaths(root, entry.manifest, "skills").map(path => ({
      plugin: entry.name, path, name: basename(resolve(path, ".."))
    }));
  });
}
export function addMarketplace(name: string, source: string, home = storeRoot()): void {
  if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid marketplace name");
  parseSource(source);
  const registry = loadRegistry(home);
  registry.marketplaces[name] = source;
  saveRegistry(registry, home);
}
export function resolvePlugin(name: string, home = storeRoot()): string {
  if (name.startsWith("github:") || name.startsWith("https://github.com/")) return name;
  const markets = loadRegistry(home).marketplaces;
  const [market, plugin] = name.includes(":") ? name.split(":", 2) : [Object.keys(markets)[0], name];
  if (!market || !markets[market] || !plugin) throw new Error("Plugin name requires configured marketplace, or use github:owner/repo/plugin");
  return markets[market].replace(/\/$/, "") + "/" + plugin;
}
