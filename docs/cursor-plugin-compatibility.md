# Cursor plugin compatibility

pstack is the compatibility target. Installing it with `/cursor-plugin` exposes the same skills, agents, and rules Pi can run.

| Component                           | Current state                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Cursor `.cursor-plugin/plugin.json` | Manifest detection, discovery, and Pi resource paths                                     |
| Agent Plugins `plugin.json`         | Manifest detection and discovery                                                         |
| Skills                              | Pi skill paths plus Cursor slash names such as `/poteto-mode`                            |
| Commands                            | Pi prompt templates                                                                      |
| Rules                               | `alwaysApply` rules are appended to the system prompt, including `~/.cursor/rules`       |
| Agents                              | `Task` spawns `poteto-agent`, `comment-sicko`, and `generalPurpose` through `pi --print` |
| AskQuestion / TodoWrite             | `AskQuestion` and `TodoWrite` tools                                                      |
| MCP servers                         | Not started from the plugin. Readonly children pass `--no-mcp`                           |
| Hooks                               | Not executed. pstack does not ship any                                                   |
| Marketplace                         | GitHub repository aliases                                                                |
| Updates                             | Re-clone source and record the resulting commit SHA                                      |

`/setup-pstack` still writes `~/.cursor/rules/pstack-models.mdc`. The extension reads that file on each run, so the model map applies inside Pi. Subagents are nested Pi processes with a persistent `--session-id`, so `Task` `resume` continues that Pi session. `poteto-agent` defaults to the background because its `is_background` frontmatter is true. `readonly` limits tools to `read,grep,find,ls` and passes `--no-mcp`. `auto` or `inherit-parent` leaves the model unset. `environment: "cloud"` and `cloud_base_branch` return an error telling the caller to respawn with `environment: "local"`, because Pi has no Cursor cloud VM. A non-readonly child keeps the Pi user's own MCP servers. Skills with `paths` are inlined when the user prompt names a matching file. Hooks are not executed.
