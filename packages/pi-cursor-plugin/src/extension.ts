import { basename } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { addMarketplace, inspect, install, listSkills, loadRegistry, resolvePlugin, setEnabled, uninstall } from "./manager.js";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cursor-plugin", {
    description: "Manage Cursor-compatible plugins: marketplace, install, list, inspect, doctor, enable, disable, update, uninstall, skills",
    handler: async (input, ctx) => {
      const [operation = "help", ...arguments_] = input.trim().split(/\s+/);
      const value = arguments_.join(" ");
      const notify = (message: string, level: "info" | "error" = "info") => ctx.ui.notify(message, level);
      try {
        if (operation === "list") {
          const entries = Object.values(loadRegistry().plugins);
          notify(entries.length ? entries.map(p => `${p.name} ${p.manifest.version || "unversioned"} ${p.enabled ? "enabled" : "disabled"}`).join("\n") : "No plugins installed");
        } else if (operation === "marketplace") {
          if (arguments_[0] === "add" && arguments_[1]) {
            const source = arguments_[1];
            const name = arguments_[2] || basename(source);
            addMarketplace(name, source);
            notify(`Marketplace ${name} registered: ${source}`);
          } else if (arguments_[0] === "list") {
            notify(JSON.stringify(loadRegistry().marketplaces, null, 2));
          } else notify("Usage: /cursor-plugin marketplace add github:owner/repo [name] | marketplace list", "error");
        } else if (operation === "install" && value) {
          const installed = install(resolvePlugin(value));
          notify(`Installed ${installed.name} at ${installed.revision.slice(0, 12)}. Run /reload to refresh discovered resources.`);
        } else if (operation === "update" && value) {
          const plugin = loadRegistry().plugins[value];
          if (!plugin) throw new Error("Not installed: " + value);
          const updated = install(plugin.source);
          notify(`Updated ${updated.name}. Run /reload.`);
        } else if (operation === "uninstall" && value) {
          uninstall(value);
          notify(`Uninstalled ${value}; run /reload.`);
        } else if ((operation === "enable" || operation === "disable") && value) {
          setEnabled(value, operation === "enable");
          notify(`${value} ${operation}d; run /reload.`);
        } else if ((operation === "inspect" || operation === "doctor") && value) {
          const result = inspect(value);
          notify(JSON.stringify(result, null, 2));
        } else if (operation === "skills") {
          const skills = listSkills();
          notify(skills.length ? skills.map(s => `${s.plugin}/${s.name}: ${s.path}`).join("\n") : "No enabled skills");
        } else {
          notify("Usage: /cursor-plugin [marketplace add|marketplace list|install|update|uninstall|enable|disable|list|inspect|doctor|skills]");
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });

  // Register already-installed upstream skills as commands at extension load time.
  // Runtime installation requires /reload to register newly available commands.
  for (const skill of listSkills()) {
    const command = `cursor-${skill.plugin}-${skill.name}`;
    pi.registerCommand(command, {
      description: `Cursor skill ${skill.plugin}/${skill.name}`,
      handler: async (args, ctx) => {
        const markdown = readFileSync(skill.path, "utf8");
        pi.sendUserMessage(`Use the following upstream Cursor plugin skill instructions. Resolve relative resources from ${skill.path}.\n\n${markdown}\n\nUser task: ${args}`);
      }
    });
  }
}
