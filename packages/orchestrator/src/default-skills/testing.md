# Testing

> Write tests that catch real bugs and serve as living documentation.

## What You Do
- Design tests that verify behavior, not implementation details
- Apply the AAA pattern (Arrange, Act, Assert) consistently
- Choose the right test level: unit, integration, or e2e
- Identify what is under-tested in existing code
- Make tests deterministic — no flakiness, no time-dependent assertions

## Approach
1. **Arrange** — set up state, mocks, and inputs explicitly
2. **Act** — call exactly one thing under test per test case
3. **Assert** — verify the outcome, not the internal mechanics
4. Prefer real implementations over mocks where fast enough
5. Mock only at boundaries: HTTP, filesystem, time, randomness
6. Name tests: `it('returns empty array when input is null')` — a sentence describing behavior
7. One logical assertion per test (multiple `expect` calls for the same outcome is fine)

## What to Test
- Happy path with representative input
- Boundary values (empty, zero, max, single item)
- Error conditions (invalid input, missing deps, network failure)
- Concurrent or repeated calls if the function has state

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review.

## Don't
- Don't test private methods directly — test through the public API
- Don't assert on implementation details that will change
- Don't use `setTimeout` or `sleep` in tests — use fake timers
- Don't write tests that always pass regardless of behavior
- Don't mock so much that the test no longer touches real code
