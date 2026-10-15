# Pi Cursor Plugin Manager

A Pi extension that installs Cursor plugins and runs pstack with Pi's skill loader, slash commands, rules, and subagents.

## Status

Targets Pi coding agent 1.2.0 (`@earendil-works/pi-coding-agent`). pstack skills keep their frontmatter and are available under the Cursor slash names (`/poteto-mode`, `/how`, `/setup-pstack`). `poteto-agent` and `comment-sicko` run through the `Task` tool. `poteto-agent` starts in the background, and `Task` `resume` continues its Pi session. `auto` or `inherit-parent` runs that child on the parent Pi model and thinking level. `AskQuestion` accepts Cursor's `prompt` field and `{ id, label }` options. `TodoWrite` keeps that list on the system prompt and in the Pi widget, and restores it when the same session starts again. `alwaysApply` rules, including the file written by `/setup-pstack`, are added to the system prompt. A skill or rule with `paths` is inlined when the prompt names a matching file or the agent has read or edited one. `*.ts` matches a nested file, and project `.cursor/rules` load only when that project is trusted.

`Task` `environment: "cloud"` starts a Cursor cloud agent when `CURSOR_API_KEY` is set and the checkout has a GitHub `origin`. A missing key or origin returns an error so the caller can respawn with `environment: "local"`. `cloud_base_branch` selects the cloud starting ref, and a `bc-` agent id resumes that cloud agent. A rejected model slug lists the closest slugs of the same family. Readonly local subagents pass `--no-mcp` and are told to respawn with `readonly` false when they need MCP. A second concurrent writable local Task gets its own git worktree at `~/.cursor/worktrees/<repo>/<task-id>` on branch `pstack/<task-id>`. Readonly Tasks and the first writer stay in the parent checkout, and resume reuses the recorded checkout. A non-readonly agent registers servers from `~/.cursor/mcp.json`, the project `.cursor/mcp.json`, and plugins enabled in this manager, writes them to `~/.cursor/projects/<slug>/mcps` with a `tools/` descriptor for each connected tool, and lists them for `/why` and `/reflect`. The system prompt names this workspace's `agent-transcripts` directory and the agent store, and the Pi session is written to `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` so `/reflect` and `/recall` can read it. A Task in a git worktree writes that transcript into the parent workspace directory. Hooks are not executed. pstack does not ship hooks or its own MCP servers.

## Install

```bash
pnpm install
pnpm --filter @yu-iskw/pi-cursor-plugin build
pi install ./packages/pi-cursor-plugin
```

`pi` is `@earendil-works/pi-coding-agent@1.2.0`.

## Usage

```text
/cursor-plugin marketplace add github:cursor/plugins official
/cursor-plugin install pstack
/cursor-plugin install official:thermos
/cursor-plugin install github:cursor/plugins/cursor-team-kit
/cursor-plugin list
/cursor-plugin skills
/cursor-plugin inspect pstack
/cursor-plugin doctor pstack
/cursor-plugin disable thermos
/cursor-plugin enable thermos
/cursor-plugin update pstack
/cursor-plugin uninstall thermos
/poteto-mode investigate the plugin loader
/setup-pstack
```

Install, update, enable, and disable reload Pi so new skills and slash commands are registered. `/poteto-mode` loads that skill the same way Pi loads `/skill:name`: the body is in a skill block and relative files resolve from the skill directory.

## Security and limitations

Installing a package downloads source with git and does not run plugin install scripts or hooks. The `task` tool starts `pi --print` for a subagent and does not execute repository hooks. GitHub URLs are limited to public GitHub repositories. Marketplace aliases map to repository roots. Review plugin instructions before enabling them.

Review the `AGENTS.md` instructions in this repository before developing changes. Run `pnpm test`, `pnpm build`, and `pnpm lint` for validation.
