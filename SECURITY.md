# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.2.x   | Yes                |
| < 0.2   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability in gossipcat, please report it responsibly:

1. **Do NOT open a public issue**
2. Email **ataberkyavuzer@protonmail.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Affected files/lines if known
   - Severity assessment (critical/high/medium/low)

You should receive a response within 48 hours. We will work with you to understand the issue, confirm the fix, and coordinate disclosure.

## Scope

Security issues we care about:

- **Path traversal** in agent ID, task ID, or memory file operations
- **Prompt injection** via agent-controlled content flowing into LLM system prompts
- **Credential exposure** in logs, error messages, or dashboard output
- **Unauthorized file access** outside the `.gossip/` directory tree
- **WebSocket authentication bypass** on the relay server
- **Denial of service** via unbounded memory growth, regex catastrophic backtracking, or resource exhaustion

## Out of Scope

- Vulnerabilities in upstream dependencies (report to the dependency maintainer)
- Issues requiring physical access to the machine
- Social engineering attacks
- Findings about the LLM models themselves (hallucination rates, jailbreaks)

## Security Hardening

The codebase uses several defense-in-depth patterns:

- `agentId` validation before all path construction (memory-writer, memory-compactor, agent-memory, skill-loader, memory-searcher)
- `realpathSync` + allowlist path validation in verify-memory
- Sentinel escaping for LLM prompt injection defense
- Atomic `O_EXCL` file locking for concurrent write protection
- Boundary escape detection for scoped/worktree agent writes

See `docs/HANDBOOK.md` for architectural invariants.
