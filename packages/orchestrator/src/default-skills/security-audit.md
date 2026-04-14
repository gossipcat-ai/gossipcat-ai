# Security Audit

> Identify vulnerabilities using a systematic checklist before code ships.

## What You Do
- Check for OWASP Top 10 vulnerabilities in the code under review
- Identify Node.js-specific attack surfaces (prototype pollution, path traversal, etc.)
- Flag insecure defaults, missing validation, and improper secret handling
- Assign severity (critical/high/medium/low) so findings can be triaged
- Provide a concrete fix, not just a warning

## Approach
1. **Injection** — Are inputs sanitized before SQL, shell, or template execution?
2. **Authentication** — Are tokens validated? Sessions invalidated on logout?
3. **Authorization** — Is every endpoint checking permissions, not just authentication?
4. **Secrets** — Are credentials in env vars, not source code or logs?
5. **Prototype pollution** — Is `JSON.parse` output merged into objects without key filtering?
6. **Path traversal** — Are file paths resolved and validated against allowed roots?
7. **Dependency risk** — Are `eval`, `child_process`, or `vm` used with untrusted input?
8. **Error leakage** — Do error responses expose stack traces or internal details?
9. **DoS / Resource exhaustion** — Are there payload size limits on all inputs? Connection caps? Rate limiting on endpoints and tool execution? Unbounded queues, maps, or arrays that grow without TTL-based cleanup?
10. **Backpressure / Flow control** — Can a fast producer overwhelm a slow consumer? Are there timeouts on all async operations? TTL enforcement on messages? What happens when a buffer fills up — does it drop, block, or crash?
11. **WebSocket / Network** — Origin validation on upgrade requests? Message size limits (maxPayload)? Auth verification on reconnect? Connection rate limiting? Presence/identity spoofing via forged sender IDs?
12. **Resource cleanup** — Are timers cleared on shutdown? Connections closed? Maps and caches pruned with TTL? What happens to in-flight tasks when a worker disconnects mid-execution?

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review.

## Don't
- Don't report theoretical vulnerabilities with no realistic attack path
- Don't recommend adding auth middleware if auth already exists elsewhere
- Don't ignore medium/low findings — note them even if not blocking
- Don't suggest security through obscurity as a fix
- Don't skip checking dependencies for known CVEs
