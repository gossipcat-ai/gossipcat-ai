#!/usr/bin/env npx tsx
// In-tree verification for issue #410 fix (PRs #411/#412/#414).
//
// Instantiates SkillEngine pointed at /Users/goku/Desktop/audit-team, captures
// what would be sent to the LLM for tech-stack detection, and prints both
// the captured LLM input AND the <tech_stack> block that ends up in the
// skill-develop system prompt. Verifies the audit-team Bug #2 fix without
// touching the network or publishing the package.
//
// Usage: npx tsx scripts/test-tech-stack-audit-team.ts [projectRoot]
// Default projectRoot: /Users/goku/Desktop/audit-team

import { SkillEngine } from '../packages/orchestrator/src/skill-engine';
import { PerformanceReader } from '../packages/orchestrator/src/performance-reader';
import type { ILLMProvider, LLMMessage, LLMResponse, LLMGenerateOptions } from '../packages/orchestrator/src/llm-client';

const projectRoot = process.argv[2] ?? '/Users/goku/Desktop/audit-team';

// Capture every LLM call so we can show the orchestrator exactly what the
// detector asked. The script does NOT make real network calls — every response
// is a canned placeholder so detectTechStack and the skill generator both
// proceed to completion.
class CapturingLLM implements ILLMProvider {
  public calls: Array<{ messages: LLMMessage[]; options?: LLMGenerateOptions }> = [];

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    this.calls.push({ messages, options });
    const userContent = messages.find(m => m.role === 'user')?.content ?? '';
    // Heuristic: tech-stack detection prompt opens with "Analyze this project's tech stack".
    if (userContent.includes("Analyze this project's tech stack")) {
      return {
        text: '[CANNED tech-stack summary — script-mode, no network]',
        model: 'script-stub',
        provider: 'anthropic',
      };
    }
    // Skill generator gets a minimal valid skill body.
    return {
      text: '# Stub skill\n\n## Iron Law\n\nStub.\n',
      model: 'script-stub',
      provider: 'anthropic',
    };
  }
}

async function main() {
  const llm = new CapturingLLM();
  const perfReader = new PerformanceReader(projectRoot);
  const engine = new SkillEngine(llm, perfReader, projectRoot);

  console.log(`\n══ Tech-stack detection probe ═════════════════════════════`);
  console.log(`projectRoot: ${projectRoot}`);

  const promptData = await engine.buildPrompt('solidity-auditor', 'input_validation');

  console.log(`\n── LLM calls ─────────────────────────────────────────────`);
  console.log(`Total: ${llm.calls.length} (expect 1 if detectTechStack fired, 2 if skill gen also ran)`);

  const techStackCall = llm.calls.find(c =>
    c.messages.some(m => m.role === 'user' && m.content.includes("Analyze this project's tech stack"))
  );

  if (techStackCall) {
    console.log(`\n── Tech-stack detector input (<project_deps>) ────────────`);
    console.log(`This is what the LLM was asked to summarize:\n`);
    const userMsg = techStackCall.messages.find(m => m.role === 'user');
    console.log(userMsg?.content ?? '(no user content)');
  } else {
    console.log(`\n── Tech-stack detector NOT called ────────────────────────`);
    console.log(`Either:`);
    console.log(`  • .gossip/tech-stack.md override is present (Option C short-circuit), OR`);
    console.log(`  • totalDepCount < TECH_STACK_MIN_DEPS=3 AND no non-Node signal (Option B floor + Option A no-signal)`);
  }

  console.log(`\n── <tech_stack> block search ─────────────────────────────`);
  for (const [name, body] of [['system', promptData.system], ['user', promptData.user]] as const) {
    const m = body.match(/<tech_stack>([\s\S]*?)<\/tech_stack>/);
    console.log(`  promptData.${name}: ${m ? 'FOUND' : '(absent)'}`);
    if (m) console.log(`    ${m[0].replace(/\n/g, '\n    ')}`);
  }

  console.log(`\n── promptData field sizes ────────────────────────────────`);
  console.log(`  system: ${promptData.system.length} chars`);
  console.log(`  user:   ${promptData.user.length} chars`);
  console.log(`  skillName: ${promptData.skillName}`);
  console.log(`  skillPath: ${promptData.skillPath}`);

  console.log(`\n══ Pre-fix behavior (what the audit-team originally caught) ══`);
  console.log(`The bug: tech-stack block claimed the project was a Node.js gossip-protocol`);
  console.log(`library with readable-stream, through2, in-memory storage, no SQL.`);
  console.log(`Post-fix: the input above should reference foundry.toml / .sol files /`);
  console.log(`README content / etc. instead of "package.json: gossipcat" alone.\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
