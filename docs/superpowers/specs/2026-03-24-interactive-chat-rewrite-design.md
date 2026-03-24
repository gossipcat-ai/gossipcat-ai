# Interactive Chat Rewrite — Design Spec

> Ground-up rewrite of the gossipcat interactive chat CLI. The current `chat.ts` has accumulated too many patches and the architecture is fundamentally broken.

## Why Rewrite

The current chat.ts (500+ lines) has these structural problems:

1. **@clack/prompts corrupts readline** — any interactive select/confirm breaks stdin, making subsequent input impossible
2. **Custom inlineSelect has rendering bugs** — infinite re-render loops, cursor position corruption
3. **No state machine** — the REPL mixes free-text, choices, init flow, and commands in one flat handler with scattered flags (`pendingChoices`, `activeWriteMode`, `pendingTask`)
4. **renderResponse is recursive** — choice → handleChoice → renderResponse → choice creates deep call stacks and hard-to-trace bugs
5. **No spinner during async operations** — user sees a blank cursor with no feedback
6. **Config is static** — `configToAgentConfigs(config)` caches the initial config, doesn't reflect runtime changes (agents added after init)

## What Works (Keep)

The backend orchestrator layer is solid:
- `MainAgent.handleMessage()` with cognitive/decompose modes
- `ToolRouter` + `ToolExecutor` with 11 tool handlers
- `ProjectInitializer` with archetype catalog and hybrid scoring
- `TeamManager` for team evolution
- Consensus protocol end-to-end
- 558+ tests passing

Only `apps/cli/src/chat.ts` needs rewriting. The orchestrator API stays the same.

## Design Principles

1. **Readline only** — no @clack/prompts, no inquirer, no raw stdin mode. Just `readline.createInterface` for all input.
2. **Numbered choices** — when the system presents options, show numbered list. User types a number. Simple, reliable, no terminal corruption.
3. **State machine** — explicit states: `idle`, `waiting_for_choice`, `processing`, `init_flow`. Each state defines what input means.
4. **No recursive renderResponse** — flat output. If a response has choices, set state to `waiting_for_choice` and return. The next line input resolves the choice.
5. **Dynamic config** — always read agent count from `mainAgent` registry, not the static config object.
6. **Clear feedback** — every async operation shows a spinner. Every error shows a message. No blank cursors.

## Architecture

```
┌──────────────────────────────────────────┐
│            ChatSession                    │
│                                          │
│  state: 'idle' | 'choice' | 'processing'│
│  mainAgent: MainAgent                    │
│  rl: readline.Interface                  │
│  history: string[]                       │
│                                          │
│  onInput(line) ──→ route by state:       │
│    idle      → handleFreeText(line)      │
│    choice    → handleChoice(line)        │
│    processing → queue (ignore input)     │
│                                          │
│  display(response) ──→ render text       │
│    if choices → show numbered list,      │
│                 set state = 'choice'     │
│    else       → set state = 'idle'       │
│                                          │
│  spinner ──→ show/hide during async ops  │
└──────────────────────────────────────────┘
```

### State Machine

```
         ┌─────────┐
    ┌───→│  idle    │←──────────────┐
    │    └────┬─────┘               │
    │         │ user types          │
    │         ▼                     │
    │    ┌──────────┐               │
    │    │processing │──→ display() │
    │    └──────────┘      │        │
    │                      │        │
    │              has choices?      │
    │              ├── no ──────────┘
    │              ▼
    │    ┌──────────┐
    │    │  choice   │
    │    └────┬─────┘
    │         │ user types number
    │         ▼
    │    ┌──────────┐
    └────│processing │──→ display()
         └──────────┘
```

### File Structure

| File | Responsibility |
|------|----------------|
| `apps/cli/src/chat-session.ts` | **New.** ChatSession class with state machine, input routing, display |
| `apps/cli/src/chat-renderer.ts` | **New.** Format ChatResponse for terminal — text, choices, spinners, errors |
| `apps/cli/src/chat.ts` | **Rewrite.** Thin entry point: boot infrastructure, create ChatSession, start REPL |
| `apps/cli/src/spinner.ts` | **New.** Simple inline spinner (no raw mode, just "⠋ thinking...") |

### ChatSession Class

```typescript
class ChatSession {
  private state: 'idle' | 'choice' | 'processing' = 'idle';
  private pendingOptions: Array<{ value: string; label: string }> | null = null;
  private pendingOriginalMessage: string = '';
  private mainAgent: MainAgent;
  private rl: readline.Interface;
  private renderer: ChatRenderer;
  private spinner: Spinner;

  constructor(mainAgent: MainAgent, config: GossipConfig) { ... }

  /** Called on every line of input */
  async onInput(line: string): Promise<void> {
    const input = line.trim();
    if (!input) { this.prompt(); return; }
    if (input === 'exit') { await this.shutdown(); return; }

    switch (this.state) {
      case 'idle':
        if (input.startsWith('/')) {
          await this.handleCommand(input);
        } else {
          await this.handleFreeText(input);
        }
        break;

      case 'choice':
        await this.handleChoiceInput(input);
        break;

      case 'processing':
        // Ignore input while processing
        break;
    }
  }

  private async handleFreeText(input: string): Promise<void> {
    this.state = 'processing';
    this.spinner.start(this.mainAgent.hasAgents() ? 'thinking...' : 'analyzing project...');

    try {
      const response = await this.mainAgent.handleMessage(input);
      this.spinner.stop();
      this.display(response, input);
    } catch (err) {
      this.spinner.stop();
      this.renderer.error(err);
      this.state = 'idle';
      this.prompt();
    }
  }

  private async handleChoiceInput(input: string): Promise<void> {
    if (!this.pendingOptions) { this.state = 'idle'; this.prompt(); return; }

    // Match by number
    const num = parseInt(input, 10);
    let selectedValue: string | undefined;
    if (num >= 1 && num <= this.pendingOptions.length) {
      selectedValue = this.pendingOptions[num - 1].value;
    } else {
      // Match by name
      const match = this.pendingOptions.find(o =>
        o.value.toLowerCase() === input.toLowerCase() ||
        o.label.toLowerCase() === input.toLowerCase()
      );
      selectedValue = match?.value;
    }

    if (!selectedValue) {
      this.renderer.warn(`Pick 1-${this.pendingOptions.length}`);
      this.prompt();
      return;
    }

    this.state = 'processing';
    this.pendingOptions = null;
    this.spinner.start('processing...');

    try {
      const response = await this.mainAgent.handleChoice(
        this.pendingOriginalMessage, selectedValue
      );
      this.spinner.stop();
      this.display(response, this.pendingOriginalMessage);
    } catch (err) {
      this.spinner.stop();
      this.renderer.error(err);
      this.state = 'idle';
      this.prompt();
    }
  }

  /** Render a ChatResponse — NEVER recursive */
  private display(response: ChatResponse, originalMessage: string): void {
    // Show text
    if (response.text) {
      this.renderer.text(response.text);
    }

    // Show choices if present — set state, don't recurse
    if (response.choices && response.choices.options.length > 0) {
      this.renderer.choices(response.choices.options);
      this.pendingOptions = response.choices.options;
      this.pendingOriginalMessage = originalMessage;
      this.state = 'choice';
    } else {
      this.state = 'idle';
    }

    this.prompt();
  }

  private prompt(): void {
    if (this.state === 'choice') {
      this.rl.setPrompt('  choice> ');
    } else {
      this.rl.setPrompt('> ');
    }
    this.rl.prompt();
  }
}
```

### ChatRenderer

```typescript
class ChatRenderer {
  text(content: string): void {
    console.log('');
    console.log(content);
    console.log('');
  }

  choices(options: Array<{ value: string; label: string; hint?: string }>): void {
    console.log('');
    for (let i = 0; i < options.length; i++) {
      const hint = options[i].hint ? ` (${options[i].hint})` : '';
      console.log(`  ${i + 1}. ${options[i].label}${hint}`);
    }
    console.log('');
  }

  error(err: unknown): void {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.log(`\n  Error: ${msg}\n`);
  }

  warn(msg: string): void {
    console.log(`  ${msg}`);
  }

  info(msg: string): void {
    console.log(`  ${msg}`);
  }
}
```

### Spinner

```typescript
class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;

  start(message: string): void {
    this.idx = 0;
    this.interval = setInterval(() => {
      process.stdout.write(`\r  ${this.frames[this.idx++ % this.frames.length]} ${message}`);
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write('\r\x1b[K'); // clear line
    }
  }
}
```

### Boot Flow (chat.ts entry point)

```typescript
export async function startChat(config: GossipConfig): Promise<void> {
  const spinner = new Spinner();
  spinner.start('Starting Gossip Mesh...');

  // Boot relay, tool server, main agent (same as today)
  const relay = new RelayServer({ port: 0 });
  await relay.start();
  const toolServer = new ToolServer({ ... });
  await toolServer.start();
  const mainAgent = new MainAgent({ ... });
  await mainAgent.start();

  spinner.stop();

  // Show welcome
  const agentCount = mainAgent.getAgentCount();
  if (agentCount === 0) {
    console.log('Ready — orchestrator online, no agents yet');
    console.log('  Describe your project and I\'ll set up a team.\n');
  } else {
    console.log(`Ready — ${agentCount} agents online\n`);
  }

  // Create and start chat session
  const session = new ChatSession(mainAgent, config);
  session.start();
}
```

## Key Differences from Current

| Current | Rewrite |
|---------|---------|
| @clack/prompts for choices | Numbered list + readline |
| Recursive renderResponse | Flat display() — never recurses |
| Scattered state flags | Explicit state machine (idle/choice/processing) |
| Raw stdin mode for selector | No raw mode ever — all through readline |
| Static config for agent count | Dynamic from mainAgent registry |
| 500+ lines in one file | 4 focused files (session, renderer, spinner, entry) |
| Spinner via process.stdout.write | Dedicated Spinner class with animation |
| handleChoice called from renderResponse | handleChoice called from onInput when state=choice |

## What About Arrow-Key Selection?

Deferred. The numbered approach works reliably. Arrow-key selection requires raw stdin which breaks readline. If we want it later, it should be implemented as a separate terminal UI mode (not mixed with readline).

## Testing

- `tests/cli/chat-session.test.ts` — unit test ChatSession with mock MainAgent
- `tests/cli/chat-renderer.test.ts` — verify output formatting
- `tests/cli/chat-e2e.test.ts` — simulate full session (boot → init → accept → task)

## Migration

1. Rename current `chat.ts` to `chat-legacy.ts`
2. Create new files: `chat-session.ts`, `chat-renderer.ts`, `spinner.ts`
3. Rewrite `chat.ts` as thin boot entry point
4. Run side-by-side until new version is stable
5. Delete legacy
