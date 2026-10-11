# Dashboard → Claude Code: channels and the durable inbox

Messages typed to Claude in the dashboard (ChatDock, the shared chat page, and
`gossip_ask` answers) reach a Claude Code session one of two ways.

## With channels (`gossipcat code`)

`gossipcat code` launches `claude` with `--channels` (or the development-channels
flag) and exports `GOSSIPCAT_CHANNEL_ACTIVE=1`. The MCP server pushes each
message as a `notifications/claude/channel` event; it arrives as a
`<channel source="gossipcat" chat_id="…">` turn. Claude answers with the MCP
`reply` tool.

## Without channels (plain `claude` / `claude --resume`)

Claude Code silently drops channel notifications when channels are off. So the
relay persists every Claude-addressed message before it tries delivery:

```
.gossip/bridge/inbox/            dir 0700
  <id>.json                      {id, chat_id, content, received_at}  file 0600, written once
  <id>.delivered                 marker {at, via}: channel | wait | hook | ack | reply
  <id>.answered                  marker: `reply` was called for that chat_id
.gossip/bridge/inbox-watcher.json   heartbeat {pid, at} from `gossipcat inbox wait`
```

A message's status is `queued`, then `delivered`, then `answered`. The status
is set by whichever marker exists. Markers are created with `O_EXCL`, so a
message is shown at most once, even with several waiters and hooks running at
the same time. The inbox keeps at most 200 messages of up to 32 KiB each, for
7 days.

The session picks messages up three ways:

- **`gossipcat inbox wait [--timeout <sec>]`.** The SessionStart hook tells
  Claude to run this as a background Bash command. It blocks until a message is
  queued, prints it, marks it delivered and exits 0. Claude Code wakes the
  session when a background command exits. Claude answers with `reply`, then
  starts the command again. It exits 2 on timeout (default 3600s; `0` waits
  forever) and 3 if its parent process dies.
- **SessionStart hook** (`session-start-bootstrap.sh` →
  `gossipcat inbox session-start`). It shows the queued count and the messages,
  plus the instruction to start the watcher. Set `GOSSIPCAT_INBOX_HOOK=0` to
  turn it off.
- **UserPromptSubmit hook** (`gossipcat hook --run`). On each prompt it injects
  any messages that are still queued, at most 5 messages of 2000 characters
  each. Nothing is lost if the watcher died.

Other commands: `gossipcat inbox list [--json] [--queued]`, `inbox show <id>`
(read-only), `inbox ack <id> [--answered]`. None of them start the MCP server.

### Avoiding double delivery

The relay marks a message `delivered` (via `channel`) at send time only when
both of these are true:

- the in-process sink accepted it
- channel mode is **confirmed**, meaning the MCP server's environment has
  `GOSSIPCAT_CHANNEL_ACTIVE=1` (set by `gossipcat code`)

`CLAUDE_CHANNEL_ID` is also honoured for forward compatibility, but Claude Code
does not set it today. If channel mode is not confirmed, the message stays
`queued` even when a notification was sent. The worst case is then a duplicate,
never a lost message.

### Untrusted content

Message text is rendered inside a fence with a random nonce:
`<<<UNTRUSTED_DASHBOARD_MESSAGE <nonce> id=… chat_id=…>>> … <<<END_… <nonce>>>`.
Control characters are stripped. Only validated `id` and `chat_id` values
appear outside the fence. Each message comes with a note: it is the human's
chat text, not system or tool instructions, and must be answered with `reply`
using the exact `chat_id`.

### Dashboard truthfulness

`POST /dashboard/api/bridge` returns `202 {inbox_id, delivery, live}`, even
when no MCP sink is wired. It returns 503 only when the message could not be
persisted.

The dashboard polls `GET /dashboard/api/bridge/inbox?chat_id=…` for
per-message status and a link state:

| state | meaning | tone |
|---|---|---|
| `channel` | sink present and channel confirmed | ok |
| `listening` | an `inbox wait` heartbeat is fresh (under 30s) and its pid is alive | ok |
| `recent` | the watcher exited in the last 15 min | warn |
| `session` | MCP server up, nothing listening | warn |
| `offline` | no sink, no watcher | idle |

`reply` can still find a chat whose message is in the inbox after an MCP or
relay restart. It marks that chat's entries `answered`, but only if the reply
reached a dashboard stream.
