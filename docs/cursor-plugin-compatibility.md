# Cursor plugin compatibility

| Component | Current state |
|---|---|
| Cursor .cursor-plugin/plugin.json | Basic manifest detection and discovery |
| Agent Plugins plugin.json | Basic manifest detection and discovery |
| Skills | Discovered and dynamically registered as Pi commands at startup |
| Commands | Readable via manifest inspection; execution not yet translated |
| Rules | Discoverable, activation not implemented |
| Agents | Discoverable, child process semantics not implemented |
| MCP servers | Not started |
| Hooks | Intentionally disabled |
| Marketplace | GitHub repository aliases; not Cursor hosted marketplace API |
| Updates | Re-clone source, record resulting commit SHA |
| Lockfile | Registry includes SHA; no independent lockfile |

This initial implementation does not promise full Cursor runtime compatibility.
