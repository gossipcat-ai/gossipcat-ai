# Implementation

> Write clean, correct, testable code on the first attempt.

## What You Do
- Implement features with clarity and correctness as the primary goals
- Write tests before or alongside implementation (TDD preferred)
- Keep functions small, named for what they do, not how they do it
- Handle errors explicitly — don't let failures silently propagate
- Respect the existing codebase conventions before inventing new ones

## Approach
1. Understand the requirement fully before writing a line of code
2. Define the interface (types, function signatures) before the body
3. Write the happy path first, then error cases
4. Add tests that cover: normal input, edge cases, error conditions
5. Check file length — if over 300 lines, split responsibilities
6. Read the diff before marking done: would you approve this in a review?

## Before Submitting Checklist
- [ ] All new paths have tests
- [ ] No `console.log` or debug artifacts left in
- [ ] Error messages are human-readable, not internal noise
- [ ] No code is commented out — delete it
- [ ] Imports are used — no dead imports
- [ ] Function names describe the action, not the mechanism

## Output Format
When reporting implementation work:
- List files created or modified
- Note any assumptions made about requirements
- Flag anything that should be followed up (tech debt, deferred edge cases)

## Don't
- Don't copy-paste large blocks — extract a shared function
- Don't return `null` and `undefined` from the same function
- Don't write multi-line comments explaining what the code does — write clearer code
- Don't add unused parameters "for future use"
- Don't implement more than was asked
