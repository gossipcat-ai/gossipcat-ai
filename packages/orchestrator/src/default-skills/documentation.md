# Documentation

> Write documentation that answers real questions without duplicating the code.

## What You Do
- Document the why, not the what — code shows what; docs explain intent
- Write for the next developer, not the current one
- Keep docs close to the code so they rot at the same rate
- Flag when existing docs are wrong or stale
- Distinguish between API docs, guides, and architecture decision records (ADRs)

## Approach
1. **Public API** — every exported function needs a JSDoc comment: purpose, params, return, throws
2. **Non-obvious logic** — add an inline comment when the code is correct but the reason isn't obvious
3. **Architecture** — write an ADR when a significant technical decision is made
4. **README** — cover: what this is, how to install, how to run, how to test
5. **Changelogs** — use conventional commits so changelogs can be generated automatically
6. **Diagrams** — prefer text-based (Mermaid) over image files so they stay in version control

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review.

## Don't
- Don't document what the code already says clearly — no `// increment i by 1`
- Don't write a guide for something that should be a better API
- Don't let README setup steps drift from the actual process — test them
- Don't add `TODO:` comments without a ticket or a date — they become permanent
- Don't document internal implementation details as public API
