---
name: gossipcat
description: Use when installing or setting up gossipcat multi-agent orchestration (parallel review, consensus, adaptive dispatch) in Claude Code or Cursor. Installs the gossipcat MCP server and hands off to gossip_status() for all live rules.
---

# Install gossipcat

gossipcat is an **MCP server** (a running relay + tool server + native-agent dispatch),
not a set of prompt rules. This skill installs the server. Once it is connected, **all
operational rules — dispatch, consensus, signals — load live from `gossip_status()` and
stay in sync with the running server.** This skill does not carry them.

## Steps

1. **Detect the host.** Check the environment:
   - `echo $CLAUDECODE` prints `1` → **Claude Code**.
   - `echo $CURSOR` is set, or you are running inside Cursor → **Cursor**.
   If unclear, ask the user which one they use.

2. **Ask the user: global or project-local install?**

3. **Run the matching commands.**

   **Global** (works for both Claude Code and Cursor):
   ```bash
   npm install -g gossipcat
   claude mcp add gossipcat -s user -- gossipcat
   ```
   The `claude mcp add` step is **required** for global installs — the postinstall step
   cannot write a usable `.mcp.json` for a global install, so you must register the server
   manually. (Cursor users: add `{ "mcpServers": { "gossipcat": { "command": "gossipcat" } } }`
   to `~/.cursor/mcp.json` instead of `claude mcp add`.)

   **Project-local** (run inside the target project):
   ```bash
   npm install --save-dev gossipcat
   ```
   The postinstall step writes `.mcp.json` into the project root automatically — no
   `claude mcp add` needed. Open the IDE in that project.

4. **Reconnect.** If you added the server mid-session, run `/mcp` (Claude Code) or restart
   the IDE so the gossipcat tools load.

5. **Verify and hand off.** Call `gossip_status()`. It returns the dashboard URL, the agent
   roster, and the full live operator playbook. Print the dashboard URL for the user, then
   tell them: *"Set up a gossipcat team for this project."*

> All dispatch rules, the consensus workflow, and signal discipline are delivered by
> `gossip_status()` at runtime — they are kept in sync with the installed server version
> and are intentionally NOT duplicated in this skill.
