# Contributing to Gossipcat

Thanks for your interest in contributing. Here's how to get started.

## Development Setup

```bash
git clone https://github.com/gossipcat-ai/gossipcat-ai.git
cd gossipcat-ai
npm install
npm run build
```

### Running Tests

```bash
npm test                          # full suite (1290 tests)
npx jest tests/orchestrator/      # orchestrator only
npx jest tests/cli/               # CLI only
npx jest tests/relay/             # relay only
npx jest --watch                  # watch mode
```

### Building

```bash
npm run build:mcp                 # MCP server bundle (dist-mcp/)
npm run build:dashboard           # dashboard static assets (dist-dashboard/)
```

### TypeScript

```bash
npx tsc --noEmit -p apps/cli/tsconfig.json
npx tsc --noEmit -p packages/orchestrator/tsconfig.json
npx tsc --noEmit -p packages/relay/tsconfig.json
```

## Project Structure

```
apps/cli/src/           # MCP server entry point + handlers
packages/orchestrator/  # consensus engine, memory, scoring, skills
packages/relay/         # WebSocket relay server + dashboard API
packages/tools/         # tool server (file_read, file_grep, etc.)
packages/types/         # shared TypeScript types
packages/dashboard-v2/  # React + Vite dashboard
tests/                  # Jest test suites (mirrors packages/)
```

## Pull Request Process

1. **Branch from master** — create a feature branch (`fix/thing`, `feat/thing`)
2. **Keep it focused** — one concern per PR
3. **Tests pass** — `npm test` must pass before submitting
4. **TypeScript clean** — `npx tsc --noEmit` on the packages you touched
5. **Build the bundle** — `npm run build:mcp` after code changes

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
fix: description of what was fixed
feat: description of new feature
chore: maintenance task
docs: documentation update
```

## Architecture Decisions

Major design decisions are documented in `docs/HANDBOOK.md`. Read the "Architectural invariants" section before proposing changes to:

- Consensus protocol (grounded citation verification)
- Signal pipeline (per-agent, per-category scoring)
- Skill system (effectiveness z-test gate)
- Native dispatch (two-content-item split)

## What We're Looking For

- Bug fixes with tests
- Test coverage for the 6 excluded suites in `jest.config.base.js`
- Documentation improvements
- Dashboard polish
- New skill templates in `packages/orchestrator/src/default-skills/`

## What We're Not Looking For (Yet)

- LLM-as-judge alternatives to citation-grounded verification
- Database backends (filesystem-based is intentional)
- Alternative frontends (dashboard is minimal but functional)

## Questions?

Open a [GitHub Discussion](https://github.com/gossipcat-ai/gossipcat-ai/discussions) or file an issue.
