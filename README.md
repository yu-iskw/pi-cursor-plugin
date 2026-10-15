# Pi Cursor Plugin Manager

A native Pi extension for installing and inspecting Cursor plugin packages without modifying upstream sources.

## Status

Experimental. Supports GitHub package installation, version pinning to an installed commit, registry, enable/disable, marketplace source aliases, and skill command registration. **Not** a complete implementation of Cursor's runtime. Hooks, MCP processes, rule activation, and Cursor-specific subagent orchestration are not executed.

## Install

```bash
pnpm install
pnpm --filter @yu-iskw/pi-cursor-plugin build
pi install ./packages/pi-cursor-plugin
```

## Usage

```text
/cursor-plugin marketplace add github:cursor/plugins official
/cursor-plugin install pstack
/cursor-plugin install official:thermos
/cursor-plugin install github:cursor/plugins/cursor-team-kit
/cursor-plugin list
/cursor-plugin skills
/cursor-plugin inspect pstack
/cursor-plugin doctor thermos
/cursor-plugin disable thermos
/cursor-plugin enable thermos
/cursor-plugin update pstack
/cursor-plugin uninstall thermos
```

After installation, run `/reload` to register skill commands, for example `/cursor-pstack-skill-name task`.

## Security and limitations

Installing a package downloads source using git but does not run plugin-provided install scripts. Do not enable untrusted plugin instructions without reviewing them. No hooks or MCP servers are executed automatically. GitHub URLs are limited to public GitHub source. Marketplace aliases map to repository roots, not Cursor's hosted marketplace protocol. Relative components are discovered as read-only files. Cursor runtime parity is **not established**.

Review the `AGENTS.md` instructions in this repository before developing changes. Run `pnpm test`, `pnpm build`, and `pnpm lint` for validation.
