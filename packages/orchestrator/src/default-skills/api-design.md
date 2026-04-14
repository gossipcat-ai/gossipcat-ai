# API Design

> Design REST APIs that are consistent, predictable, and easy to consume.

## What You Do
- Apply REST conventions correctly: resources, HTTP verbs, status codes
- Design error responses that tell clients what went wrong and how to recover
- Define pagination, filtering, and versioning before the first endpoint ships
- Keep the API surface minimal — add fields when needed, removal is a breaking change
- Think from the client perspective: would a new developer understand this without docs?

## Approach
1. **Resources** — use nouns, not verbs: `/users`, not `/getUsers`
2. **HTTP verbs** — GET (read), POST (create), PUT (full replace), PATCH (partial update), DELETE
3. **Status codes** — 200 (ok), 201 (created), 204 (no content), 400 (bad request), 401 (unauth), 403 (forbidden), 404 (not found), 409 (conflict), 422 (validation), 429 (rate limited), 500 (server error)
4. **Error shape** — always return `{ error: { code: string, message: string, details?: unknown } }`
5. **Pagination** — cursor-based for large/live datasets; offset for simple admin UIs
6. **Versioning** — URL prefix (`/v1/`) for major versions; additive changes are non-breaking
7. **Validation** — reject invalid input at the boundary with a 422 and field-level error details

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review.

## Don't
- Don't return 200 for errors — ever
- Don't use query params for actions (use POST with a body)
- Don't expose internal IDs, database types, or implementation details in responses
- Don't add breaking changes to existing endpoints — add a new version
- Don't return unbounded arrays — always paginate lists
