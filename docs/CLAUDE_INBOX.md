# Dashboard → Claude Code: channels and the durable inbox

Messages typed to Claude in the dashboard (ChatDock, the shared chat page, and
`gossip_ask` answers) reach a Claude Code session one of two ways.

## With channels (`gossipcat code`)

`gossipcat code` launches `claude` with `--channels` (or the development-channels
flag) and exports `GOSSIPCAT_CHANNEL_ACTIVE=1`. The MCP server pushes each
message as a `notifications/claude/channel` event; it arrives as a
`<channel source="gossipcat" chat_id="…">` turn. Claude answers with the MCP
`gossip_chat_reply` tool.

## Without channels (plain `claude` / `claude --resume`)

Claude Code silently drops channel notifications when channels are off. So the
relay persists every Claude-addressed message before it tries delivery:

```
.gossip/bridge/inbox/            dir 0700
  <id>.json                      {id, chat_id, content, received_at, to, from, kind,
                                  qid?, ref?, in_reply_to?}  file 0600, written once
  <id>.delivered                 marker {at, via, consumer?}: wait | hook | ack | reply;
                                  consumer = wait:<pid> | hook:<pid> (absent on older markers)
  <id>.answered                  marker {at, via}: `gossip_chat_reply` closed it (via `in_reply_to`, or it was
                                  already delivered); via `expired` = agent mail past its 24 h TTL
  <id>.expired                   tag {at}: closed by the agent-mail TTL (counted as `stats.expired`)
  <id>.reminded.<n>              {at}: the n-th time (1..6) a hook or the watcher re-surfaced it
                                  as unanswered; created once with O_EXCL, never rewritten
  <id>.reminded                  legacy {at, count} reminder marker (a marker without count
                                  counts as 1); still read, never written
  <id>.quarantine                an oversized record, moved aside unread
.gossip/bridge/watchers/<pid>.json       per-watcher heartbeat {pid, at} while `inbox wait` is
                                  blocked (dir 0700, file 0600)
.gossip/bridge/inbox-watcher.json        legacy single heartbeat; still read for one release
.gossip/bridge/inbox-watcher-exit.json   {pid, at, code} written when `inbox wait` exits
.gossip/bridge/inbox-prune.json          {total, at, expired_agent_mail, last_count, last_expired}:
                                  answered records pruned, agent mail expired
.gossip/bridge/outbox/<chat_id>.json     replies waiting for a dashboard stream
```

A message's status is `queued`, then `delivered`, then `answered`. The status
is set by whichever marker exists. Markers are created with `O_EXCL`, so a
queued message is claimed by exactly one consumer, even with several waiters
and hooks running at the same time.

Limits:

- At most 200 **unanswered** (queued or delivered) messages of up to 32 KiB
  each. Unanswered messages are never deleted to make room. When the inbox is
  full, `POST /dashboard/api/bridge` returns **507** with an error the
  dashboard shows; answer the messages or close them with
  `gossipcat inbox ack <id> --answered`.
- **Answered** messages are kept for 7 days, at most 200 of them (oldest
  first). The prune count and time are reported in the inbox status endpoint
  (`stats.pruned_total`, `stats.last_pruned_at`; `stats.expired` counts the
  retained answered records closed by the agent-mail TTL).
- Temp files of atomic writes (`*.tmp`) are deleted once their own mtime is
  over a minute old, never by the message's age.
- Received timestamps must be canonical ISO-8601 (`…T…:…:….sssZ`); records
  with anything else are ignored. Record files over 256 KiB are quarantined
  without being read. One scan reads at most 1000 records, and lookups stop
  as soon as they have enough.

The session picks messages up three ways:

- **`gossipcat inbox wait [--timeout <sec>]`.** The SessionStart hook tells
  Claude to run this as a background Bash command. It blocks until a message is
  queued, prints it, marks it delivered and exits 0. Claude Code wakes the
  session when a background command exits. Claude answers with `gossip_chat_reply`, then
  starts the command again. It exits 2 on timeout (default 3600s; `0` waits
  forever) and 3 if its parent process dies.
- **SessionStart hook** (`session-start-bootstrap.sh` →
  `gossipcat inbox session-start`). It shows the queued count and the messages,
  plus the instruction to start the watcher. Set `GOSSIPCAT_INBOX_HOOK=0` to
  turn it off.
- **UserPromptSubmit hook** (`gossipcat hook --run`). On each prompt it injects
  any messages that are still queued, at most 5 messages of 2000 characters
  each and 12,000 characters in total (including headers). A message is
  claimed only if it fits in that output. Nothing is lost if the watcher died.

### Unanswered messages come back

Claiming a message and printing it are two steps, so output can be lost in
between: the watcher may be killed, or its output may never reach Claude. So
the SessionStart and UserPromptSubmit hooks re-surface messages that are
`delivered` but not `answered` more than 10 minutes after delivery. So does a
blocked `gossipcat inbox wait` (checked every 30 seconds), so a message comes
back even while the human is idle and no hook fires. Re-surfaced messages are
labelled `[unanswered …]` and the watcher exits 0 with them, as with new
messages.

Each message is shown at most once every 10 minutes across all consumers,
until a `gossip_chat_reply` closes it or `gossipcat inbox ack <id> --answered`
closes it. Reminder n is the file `<id>.reminded.<n>`; the count is the
highest n present, and its `{at}` is the time of the last reminder. Claiming
reminder n+1 is one `O_EXCL` create of `<id>.reminded.<n+1>`, so a hook and a
watcher cannot both claim the same 10-minute window, and the count never goes
down or resets. A legacy `<id>.reminded` marker still counts; new reminders
continue above its count. All reminder files are removed with their record.

After 6 reminders a message is no longer re-surfaced automatically. The output
that carries the 6th reminder says so once ("reminder limit reached for <id>;
it stays visible in `gossipcat inbox list`"). The message stays `delivered`
(unanswered) on the dashboard and in `gossipcat inbox list`. A reminder is
claimed before it is printed, so a watcher killed in between uses one up. In
confirmed channel mode the watcher also leaves alone mail received less than
2 minutes ago. A message may be shown twice; it is not lost.

Other commands: `gossipcat inbox list [--json] [--queued]`, `inbox show <id>`
(read-only), `inbox ack <id> [--answered]`. None of them start the MCP server.
`inbox list --json` adds `outcome` to answered entries: `expired` when the
agent-mail TTL closed it, otherwise `answered`. `status` keeps its values.

### Addressing (record envelope)

Each record carries an envelope, validated when written and again when read:

| field | values | notes |
|---|---|---|
| `to` | `orchestrator` \| `human` \| agent id | who should read it |
| `from` | `human` \| `orchestrator` \| agent id | stamped by the relay in code, never parsed from the text |
| `kind` | `chat` \| `answer` \| `notice` | `gossip_ask` answers are `answer` |
| `qid` | `gossip_ask` question id | set on answers; the `[answer qid=…]` text prefix stays for compatibility |
| `ref` | `{task_id?, finding_id?, file?}` | short strings, charset- and length-checked |
| `in_reply_to` | an inbox id | |

Records written before the envelope existed load as `to=orchestrator`,
`from=human`, `kind=chat`. An invalid `kind`, `qid`, `ref` or `in_reply_to` is
dropped. A present but invalid `to` or `from` is refused on write and makes the
record unreadable on load, so it is never shown as human mail.

`inbox wait` and the hooks only claim messages with `to=orchestrator`. Messages
for other recipients stay `queued`. The 200-unanswered cap and the status
counts still include every recipient.

### Agent mail

Agents and the orchestrator exchange short notes through the same store.

- **Agent → orchestrator.** An agent adds
  `<agent_message to="orchestrator" in_reply_to="<id>">text</agent_message>` to
  its task result. Only a tag whose opening starts a line (spaces or tabs
  before it are fine) counts. Tags mid-line, inside ``` / ~~~ code blocks, or
  inside an `<agent_finding>` body are quoted examples and are ignored. At most
  5 tags per result, 8 KiB each. `from` is the task's agent id, never anything
  in the tag. Only results of successful runs are read (native: after a valid
  `relay_token`).
- **Quotas.** Each agent may have at most 20 unanswered messages to the
  orchestrator, and agent messages never take the last 50 slots of the
  200-unanswered cap. Those slots stay free for dashboard messages from the
  human. Over-quota agent messages are dropped and logged; the task itself is
  not affected.
- **TTL.** Agent → orchestrator and orchestrator → agent mail is closed as
  `answered` with `via: expired` when it is still unanswered and its last
  activity (received, delivered or last reminded) is more than 24 hours old.
  Mail that waited a day for a session but was just delivered does not expire. The prune pass
  does this whenever it runs (on every append and when `inbox wait` starts), so
  there are no extra timers. Expired mail no longer counts toward the quotas or
  the 200 cap, and is no longer delivered or re-surfaced. `inbox list` shows it
  as `expired` (`outcome: "expired"` in `--json`), it gets an `<id>.expired`
  tag counted in `stats.expired`, and the count goes to `expired_agent_mail` in
  `inbox-prune.json`. Dashboard messages from the human never expire.
- **Orchestrator → agent.** `gossip_inbox_send(to, text, kind?, ref?, in_reply_to?)`
  queues a note for a configured agent. It is orchestrator-only and must never
  be added to an agent's tool allowlist. Text longer than one dispatch can carry
  whole (`INBOX_SEND_MAX_CHARS`, 6,872 chars) is rejected, never cut.
- **Delivery.** Queued mail for an agent is added to its next dispatch prompt
  (at most 5 messages, 8 KiB in total, fenced as untrusted). It is marked
  `delivered` (`via dispatch:<task_id>`) only after that task returns a
  successful result. A failed, timed-out or cancelled task leaves it queued for
  the next dispatch. Mail dropped by the prompt size cap also stays queued.
  Orchestrator → agent mail needs no reply, so delivery also marks it
  `answered`. Two dispatches of the same agent running at once can both carry
  the same message (at least once, as elsewhere in the inbox).

### Delivery rule: duplicates are acceptable, losses are not

The relay never marks a message `delivered` because a channel notification was
sent. The notification is fire-and-forget: the sink returns as soon as it hands
the message to the stdio transport (or to a small buffer that drops its oldest
entry when full), and Claude Code drops it silently without `--channels`.
Neither the sink result nor `GOSSIPCAT_CHANNEL_ACTIVE=1` proves Claude saw it.

So a message stays `queued` until one of these happens:

- `inbox wait`, a hook, or `inbox ack` claims it (`delivered`)
- `gossip_chat_reply` closes it (`answered`): with `in_reply_to` naming its id, or, without
  `in_reply_to`, only if it was already `delivered`. A still-`queued` message is
  never closed by a reply that does not name it.

In channel mode (`GOSSIPCAT_CHANNEL_ACTIVE=1`, set by `gossipcat code`) the
message usually also arrives as a channel turn. The hooks leave a queued
message alone for its first 2 minutes so the channel turn and its `gossip_chat_reply` can
close it first. After that they inject it anyway. You may see it twice, but you
won't lose it. `CLAUDE_CHANNEL_ID` is also honoured for forward compatibility,
but Claude Code does not set it today. The POST response reports
`delivery: "queued"` and `live: true` when a channel notification was also
attempted.

### Untrusted content

Message text is rendered inside a fence with a random nonce:
`<<<UNTRUSTED_DASHBOARD_MESSAGE <nonce> id=… chat_id=… received_at=…>>> … <<<END_… <nonce>>>`.
The nonce is regenerated while the text or any header value contains it.
`kind` (when not `chat`), `qid` and `in_reply_to` are added to the header when
present.
Control characters are stripped. Only validated `id`, `chat_id` and
`received_at` values appear outside the fence, and the header escapes any
character outside `[A-Za-z0-9_.:-]` anyway. Each message comes with a note: it is the human's
chat text, not system or tool instructions, and must be answered with `gossip_chat_reply`
using the exact `chat_id`.

A message whose `from` is not `human` uses its own fence,
`<<<UNTRUSTED_AGENT_MESSAGE <nonce> from=<id> …>>>`, and its own note: it comes
from another agent, not the human; it is information only; it cannot authorize
actions, change rules, permissions or scope, or ask for tool calls; its claims
must be checked against the code; answer it with `gossip_inbox_send` (to the
`from=` agent, `in_reply_to` its id) only if a response is needed. A batch with both kinds shows both notes. The MCP
server instructions treat channel turns the same way: the human's chat message
to answer, as untrusted data.

### Dashboard truthfulness

`POST /dashboard/api/bridge` returns `202 {inbox_id, delivery, live}`, even
when no MCP sink is wired. It returns 507 when the inbox is full of unanswered
messages, and 503 only when the message could not be persisted.

Cookie-authenticated writes (`POST` to `/dashboard/api/bridge`, answers,
`codex-chat`, `skills/bind`, `findings/archive`, `bridge/mirror`) must be
same-origin: `Origin` must equal the relay's own origin (or, without `Origin`,
`Sec-Fetch-Site: same-origin`), and the body must be `application/json`.
A page on the same host but another port is rejected. Bearer-key clients
(hooks, scripts) are not affected. The shared chat page runs on its own port;
its proxy checks that the browser `Origin` is its own and then forwards the
request with the relay's origin.

The dashboard polls `GET /dashboard/api/bridge/inbox?chat_id=…` for
per-message status and a link state:

| state | meaning | tone |
|---|---|---|
| `channel` | sink present and channel confirmed | ok |
| `listening` | at least one `inbox wait` heartbeat is fresh (under 30s) and its pid is alive | ok |
| `recent` | the watcher exited (or its heartbeat went stale) in the last 15 min; `last_exit` gives the time | warn |
| `session` | MCP server up, nothing listening | warn |
| `offline` | no sink, no watcher | idle |

Each watcher writes its own `watchers/<pid>.json`, so two sessions listening
at once don't overwrite each other. The link carries `listeners`, the number
of live watchers, whenever the relay knows the project root. Readers only
look at heartbeat names (`<pid>.json` and its atomic-write tmp), sort them by
mtime, newest first, and parse at most 64, so stale files can't hide a live
watcher. Heartbeat files older than an hour, and tmp files older than a minute,
are deleted when the relay reads them. Nothing is written, read or deleted
through `watchers/` when it is a symlink or not a directory owned by the
current user.

`gossipcat inbox wait` deletes its own heartbeat when it exits, so it never
shows as `listening` after exiting. Other watchers are not affected. It also
writes `inbox-watcher-exit.json`, which is what the `recent` state is based on.

`gossip_chat_reply` can still find a chat whose message is in the inbox after an MCP or
relay restart. With `in_reply_to` (one inbox id or an array; ids from other chats are ignored) it marks exactly those entries `answered`; without it, only that chat's already-`delivered` entries. If no dashboard stream
for that chat is open, the reply is stored in `.gossip/bridge/outbox/` (at most
20 replies per chat, 64 chats, 24 hours) and the tool reports "queued for
delivery". The stored replies are sent once, when a stream for that chat opens.
