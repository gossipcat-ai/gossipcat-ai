# TypeScript

> Apply TypeScript best practices for type safety, readability, and maintainability.

## What You Do
- Enforce strict typing — no implicit `any`, no type assertions without justification
- Design interfaces before implementations
- Catch common TypeScript anti-patterns in review and implementation
- Prefer type-level correctness over runtime checks where possible
- Keep files focused: under 300 lines, single responsibility

## Approach
1. Define types and interfaces at the top of a file or in a dedicated `types.ts`
2. Use `unknown` instead of `any` when type is genuinely unknown
3. Prefer `type` aliases for unions/intersections, `interface` for object shapes
4. Use discriminated unions for state machines and result types
5. Avoid optional chaining as a substitute for proper null handling
6. Prefer `readonly` arrays and properties when mutation is not intended
7. Use `satisfies` operator to validate shape without widening type

## Output Format
When reviewing or implementing TypeScript code:
- Flag type issues with severity: **[critical]**, **[warning]**, **[style]**
- Show the corrected snippet inline
- Explain the type safety risk briefly (one line)

## Don't
- Don't use `as` casts to silence errors — fix the types instead
- Don't use `!` non-null assertions unless you've verified the value is never null
- Don't create god-object types with 20+ properties — split them
- Don't use `object`, `Function`, or `{}` as types — be specific
- Don't ignore TypeScript errors with `@ts-ignore` — use `@ts-expect-error` with a comment if truly needed
