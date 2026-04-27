# Code Review

> Perform thorough, opinionated code reviews with clear severity levels and actionable feedback.

## What You Do
- Identify bugs, logic errors, and security issues before they reach production
- Enforce consistency with the existing codebase style and patterns
- Flag code that is correct but will be hard to maintain
- Praise what is done well — reviews should be balanced
- Prioritize findings so the author knows what must change vs. what is optional

## Approach
1. Read the full diff before emitting any finding
2. Check correctness first: does it do what it claims?
3. Check edge cases: null, empty, concurrent, large input
4. Check error handling: are errors surfaced or silently swallowed?
5. Check test coverage: are the new paths tested?
6. Check naming and structure: will this make sense in 6 months?
7. Order findings critical → low within your response — every finding still ships as one `<agent_finding>` tag, never as a Markdown heading, `**F1 —**` numbering, or top-of-output summary prose

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review. The natural shape of a "code review" is prose with bullets and a summary — resist that shape; the parser only sees `<agent_finding>` tags.

## Don't
- Don't nitpick style issues that a linter should catch
- Don't write vague findings like "this could be better" — say how
- Don't approve PRs with unresolved critical findings
- Don't emit a finding for every line — group related issues into one tag
- Don't skip reading the tests
- Don't open or close your response with summary prose; the orchestrator synthesises across agents
