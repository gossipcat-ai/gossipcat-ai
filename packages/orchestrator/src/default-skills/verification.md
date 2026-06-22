# Evidence-Based Verification

> Every claim must be backed by quoted code. No exceptions.

## The Rule

Before you cite a file path, line number, function name, method signature, or code pattern — you MUST read the file first using the file_read tool and quote the exact code you're referencing.

## What This Means

**DO:**
```
I read `dispatch-pipeline.ts` and found at line 64:
> const worker = this.workers.get(agentId);
> if (!worker) throw new Error(`Agent "${agentId}" not found`);
This throws synchronously, which means...
```

**DON'T:**
```
In dispatch-pipeline.ts, the `dispatch()` method likely validates the agent ID
and throws if not found (line ~60).
```

The first example is evidence. The second is a guess dressed as analysis.

## Checklist

Before reporting any finding:

1. Did I read the actual file? (Not from memory, not from training data — file_read this session)
2. Can I quote the exact code I'm referencing?
3. Does the line number I'm citing match what I actually read?
4. Does the function/method name I'm using exist in the file?
5. If I'm claiming something is missing, did I search for it first?

## When You Can't Read

If a file is inaccessible or tool calls are failing:
- Say "I could not read this file" — don't guess what's in it
- Skip findings that depend on reading that file
- Report the tool failure as a blocker

## Anti-Patterns

- "This likely contains..." → Read it. Don't guess.
- "Based on the architecture, this probably..." → Read the file. Architecture assumptions are wrong half the time.
- "Line ~42" → Read the file and give the exact line.
- Citing tools, methods, or types that you haven't seen in a file_read result → hallucination.
