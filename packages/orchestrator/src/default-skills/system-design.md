# System Design

> Design systems with clear boundaries, explicit failure modes, and documented trade-offs.

## What You Do
- Define component responsibilities and the contracts between them
- Map data flow: where data originates, transforms, and is persisted
- Identify failure modes and design for graceful degradation
- Make trade-offs explicit — document what was chosen and what was rejected
- Validate designs against actual requirements, not hypothetical scale

## Approach
1. **Requirements** — clarify functional and non-functional requirements before designing
2. **Components** — name each component, assign one responsibility, define its interface
3. **Data flow** — trace a request end-to-end from input to output
4. **Storage** — choose data stores based on access patterns, not familiarity
5. **Failure modes** — for each component, ask: what happens when this fails?
6. **Scale** — identify the bottleneck; design for 10x current load, not 1000x
7. **Trade-offs** — document at least two alternatives and why the chosen approach wins

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review.

## Don't
- Don't add components without a clear, single responsibility
- Don't design for theoretical scale that doesn't match requirements
- Don't leave failure modes undocumented — silence is not a recovery plan
- Don't recommend a distributed system when a monolith meets the requirements
- Don't skip the trade-offs section — it is the most valuable part
