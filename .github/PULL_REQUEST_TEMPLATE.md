<!--
Branch workflow convention:
  - Branch names: feat/<kebab>, fix/<kebab>, docs/<kebab>, chore/<kebab>
  - Keep PRs focused: one concern per PR
  - Run gossipcat consensus review before requesting merge (see below)
-->

## Summary

<!-- 1-3 bullets: what this changes and why -->

## gossipcat review

Before merging, run a consensus review on the diff:

```
gossip_dispatch(mode: "consensus", tasks: [
  { agent_id: "sonnet-reviewer",  task: "Review this PR for correctness, security, and logic errors. Scope: <files>" },
  { agent_id: "gemini-reviewer",  task: "Review this PR for edge cases and type safety. Scope: <files>" },
  { agent_id: "haiku-researcher", task: "Research impact on adjacent modules and call sites. Scope: <files>" },
])
```

Attach the consensus round ID in the PR body once complete:
`consensus: <round-id>`

## Test plan

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Manual verification (describe)
- [ ] No touched files outside PR scope

## Scope discipline

- [ ] Follows branch naming convention (feat/fix/docs/chore)
- [ ] Linear history (rebase, don't merge from main)
- [ ] Commits signed and have Co-Authored-By trailers where relevant
- [ ] Memory files updated if this ships or closes a backlog item
