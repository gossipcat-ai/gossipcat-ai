---
name: Gemini quota watcher
description: Backlog — no mechanism to detect or recover from Gemini 429 quota exhaustion
type: project
---

Gemini hit 429 quota limit during session 2026-04-05. Gossip summarization failed silently for sonnet-implementer. No mechanism to detect or recover.

**Why:** When Gemini quota is exhausted, relay dispatches silently fail but consensus rounds keep trying. Wastes time and produces incomplete results.

**How to apply:** Build a quota watcher that:
1. Tracks 429 responses from Gemini API
2. Pauses Gemini relay dispatches after N consecutive 429s
3. Auto-switches to native-only consensus mode
4. Surfaces quota status in `gossip_status` output
5. Resumes Gemini dispatches after cooldown period
