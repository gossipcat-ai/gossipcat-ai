/**
 * @gossip/orchestrator — Project-aware team initialization.
 * Scans project directory for signals, proposes an agent team via LLM,
 * and writes .gossip/config.json when approved.
 */
import { ILLMProvider } from './llm-client';
import { LLMMessage } from '@gossip/types';
import { ProjectSignals, ToolResult } from './types';
import { ArchetypeCatalog } from './archetype-catalog';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'fs';
import { join, resolve } from 'path';

export interface ProjectInitializerConfig {
  llm: ILLMProvider;
  projectRoot: string;
  keyProvider: (provider: string) => Promise<string | null>;
  catalogPath?: string;
}

const SIGNAL_DIRS = [
  'src', 'pages', 'app', 'components', 'contracts', 'assets',
  'terraform', 'k8s', 'android', 'ios', 'firmware', 'docs', 'packages',
];
const SIGNAL_FILES = ['Dockerfile', 'docker-compose.yml', 'hardhat.config.ts', 'foundry.toml'];
const LANG_FILES: Record<string, string> = {
  'tsconfig.json': 'TypeScript', 'Cargo.toml': 'Rust',
  'go.mod': 'Go', 'requirements.txt': 'Python', 'pyproject.toml': 'Python',
};

export class ProjectInitializer {
  private config: ProjectInitializerConfig;
  pendingTask: string | null = null;
  pendingProposal: any | null = null;

  constructor(config: ProjectInitializerConfig) { this.config = config; }

  scanDirectory(root: string): ProjectSignals {
    const absRoot = resolve(root);
    const signals: ProjectSignals = { dependencies: [], directories: [], files: [] };
    for (const [file, lang] of Object.entries(LANG_FILES)) {
      if (this.safeExists(absRoot, join(absRoot, file))) signals.language = lang;
    }
    const pkgPath = join(absRoot, 'package.json');
    if (this.safeExists(absRoot, pkgPath)) {
      signals.files.push('package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        signals.dependencies = [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ];
      } catch { /* skip malformed */ }
      if (!signals.language) signals.language = 'JavaScript';
    }
    for (const dir of SIGNAL_DIRS) {
      const p = join(absRoot, dir);
      if (this.safeExists(absRoot, p) && this.isDir(p)) signals.directories.push(`${dir}/`);
    }
    const wfPath = join(absRoot, '.github', 'workflows');
    if (this.safeExists(absRoot, wfPath) && this.isDir(wfPath)) {
      signals.directories.push('.github/workflows/');
    }
    for (const file of SIGNAL_FILES) {
      if (this.safeExists(absRoot, join(absRoot, file))) signals.files.push(file);
    }
    for (const file of Object.keys(LANG_FILES)) {
      if (this.safeExists(absRoot, join(absRoot, file))) signals.files.push(file);
    }
    return signals;
  }

  buildSignalSummary(signals: ProjectSignals): string {
    const lines: string[] = [];
    if (signals.language) lines.push(`Language: ${signals.language}`);
    if (signals.framework) lines.push(`Framework: ${signals.framework}`);
    if (signals.dependencies.length) lines.push(`Dependencies: ${signals.dependencies.join(', ')}`);
    if (signals.directories.length) lines.push(`Directories: ${signals.directories.join(', ')}`);
    if (signals.files.length) lines.push(`Files: ${signals.files.join(', ')}`);
    return lines.join('\n');
  }

  async proposeTeam(userMessage: string, signals: ProjectSignals): Promise<ToolResult> {
    const providers: string[] = [];
    for (const p of ['google', 'anthropic', 'openai']) {
      if (await this.config.keyProvider(p)) providers.push(p);
    }
    // Native Claude Code is always available as an orchestrator when running
    // under the Claude Code host — it needs no API key because the host
    // classifies via natural language through the isNullLlm path.
    const hostIsClaudeCode = process.env.CLAUDECODE === '1' || !!process.env.CLAUDE_CODE_ENTRYPOINT;
    if (!providers.length && !hostIsClaudeCode) {
      return { text: 'No API keys available. Run gossipcat setup to configure providers.' };
    }
    const catalog = new ArchetypeCatalog(this.config.catalogPath);
    const candidates = catalog.getTopCandidates(signals, userMessage);
    const candidateData = candidates.map(c => ({ id: c.id, score: c.score, ...catalog.get(c.id) }));
    const summary = this.buildSignalSummary(signals);

    // Build explicit model tiers per available provider
    const MODEL_TIERS: Record<string, { best: string; fast: string; cheapest: string }> = {
      google: { best: 'gemini-2.5-pro', fast: 'gemini-2.5-flash', cheapest: 'gemini-2.5-flash' },
      anthropic: { best: 'claude-opus-4-6', fast: 'claude-sonnet-4-6', cheapest: 'claude-haiku-4-5' },
      openai: { best: 'gpt-4o', fast: 'gpt-4o', cheapest: 'gpt-4o-mini' },
    };
    const availableModels = [
      ...(hostIsClaudeCode ? ['none: none (native Claude Code orchestration — no API key needed, preferred for main_agent on this host)'] : []),
      ...providers.map(p => {
        const tiers = MODEL_TIERS[p];
        if (!tiers) return `${p}: (use any available model)`;
        return `${p}: ${tiers.best} (best), ${tiers.fast} (fast), ${tiers.cheapest} (cheapest)`;
      }),
    ].join('\n');

    const brainstormCtx = (signals as any).brainstormContext;
    const systemPrompt = `You are configuring an agent team for a software project.

Project description: "${userMessage}"
Detected signals: ${summary}${brainstormCtx ? `\n\nBrainstorming context (use for better team composition, do NOT echo this in your response):\n${brainstormCtx}` : ''}

Available providers and models (use ONLY these exact model names):
${availableModels}

Candidate archetypes (pick one, blend, or customize):
${JSON.stringify(candidateData, null, 2)}

## Available Skills (use ONLY these exact names)

Each skill name maps to a real instruction file that gets injected into the agent's prompt.

| Skill name | What it teaches the agent |
|------------|--------------------------|
| implementation | TDD, small functions, error handling, <300 line files |
| typescript | Strict typing, interface-first, discriminated unions, type safety |
| testing | AAA pattern, unit/integration/e2e, mocking, deterministic tests |
| code_review | Bug finding, edge cases, naming, structure, error handling |
| security_audit | OWASP Top 10, injection, auth, secrets, path traversal |
| debugging | Reproduce, isolate, hypothesize, test, fix, verify |
| research | Source prioritization, triangulation, BLUF answers |
| documentation | API docs, guides, ADRs, README, changelog |
| api_design | REST conventions, HTTP verbs, status codes, pagination |
| system_design | Components, data flow, failure modes, trade-offs |
| verification | Evidence-based analysis, quote exact code, no hallucination |

## Preset base skills (always include these for the preset)

- **implementer**: always include "implementation". Add "typescript" for TS projects.
- **reviewer**: always include "code_review", "verification". Add "security_audit" if relevant.
- **tester**: always include "testing", "debugging".
- **researcher**: always include "research". Add "documentation" if the project needs docs.

You may add additional skills from the table above based on project needs. Do NOT invent skill names — only use the exact names from the table.

## Rules
- Pick the best archetype and customize roles for this specific project
- Use ONLY the exact model names listed above
- Choose models based on project complexity: simple → "fast" for all, complex → "best" for critical roles
- For the main_agent (orchestrator): ${hostIsClaudeCode ? 'PREFER { "provider": "none", "model": "none" } — native Claude Code orchestration needs no API key and is the zero-config default on this host. Only pick a keyed provider if the user explicitly asks for one.' : 'use the "best" model from the primary provider'}
- Do NOT include agent IDs — the system generates them automatically
- **Scale team size to project complexity.** Simple (single-page app, script, simple game) → 1-2 agents. Medium → 2-3. Complex multi-module → 4-5. NEVER duplicate roles.
- Max 5 agents, prefer fewer. Every agent costs money.
- If the description is too vague, respond with a [CHOICES] block asking what kind of project

Respond with JSON:
{
  "archetype": "archetype-id",
  "reason": "why this archetype fits",
  "main_agent": { "provider": "...", "model": "..." },
  "agents": [{ "provider": "...", "model": "...", "preset": "...", "skills": ["implementation", "typescript", ...] }]
}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    const response = await this.config.llm.generate(messages, { temperature: 0 });
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { text: `LLM returned unexpected format:\n${response.text}` };

    const proposal = JSON.parse(jsonMatch[0]);

    // Generate deterministic agent IDs: provider-preset (e.g., gemini-implementer)
    // Handle duplicates by appending a number (e.g., gemini-reviewer-2)
    const idCounts: Record<string, number> = {};
    for (const a of proposal.agents || []) {
      const providerShort = a.provider === 'anthropic' ? 'claude'
        : a.provider === 'openai' ? 'gpt'
        : a.provider === 'google' ? 'gemini'
        : a.provider || 'agent';
      const base = `${providerShort}-${a.preset || 'agent'}`;
      idCounts[base] = (idCounts[base] || 0) + 1;
      a.id = idCounts[base] > 1 ? `${base}-${idCounts[base]}` : base;
    }

    this.pendingProposal = proposal;
    this.pendingTask = userMessage;
    const agentList = (proposal.agents || [])
      .map((a: any) => `  - ${a.id} (${a.provider}/${a.model}) — ${a.preset}`).join('\n');

    return {
      text: `Proposed team (${proposal.archetype}): ${proposal.reason}\n\nMain: ${proposal.main_agent?.provider}/${proposal.main_agent?.model}\nAgents:\n${agentList}`,
      choices: {
        message: 'How would you like to proceed?',
        options: [
          { value: 'accept', label: 'Accept' },
          { value: 'modify', label: 'Modify' },
          { value: 'manual', label: 'Manual setup' },
          { value: 'skip', label: 'Skip' },
        ],
      },
    };
  }

  async writeConfig(projectRoot: string): Promise<void> {
    if (!this.pendingProposal) throw new Error('No pending proposal to write');
    const gossipDir = join(projectRoot, '.gossip');
    if (!existsSync(gossipDir)) mkdirSync(gossipDir, { recursive: true });
    const agents: Record<string, any> = {};
    for (const a of this.pendingProposal.agents || []) {
      agents[a.id] = { provider: a.provider, model: a.model, preset: a.preset, skills: a.skills || [] };
      const agentDir = join(gossipDir, 'agents', a.id);
      if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
    }
    const config = {
      main_agent: this.pendingProposal.main_agent,
      project: {
        description: this.pendingTask || '',
        archetype: this.pendingProposal.archetype,
        initialized: new Date().toISOString(),
      },
      agents,
    };
    writeFileSync(join(gossipDir, 'config.json'), JSON.stringify(config, null, 2));
  }

  private safeExists(root: string, target: string): boolean {
    const resolved = resolve(target);
    if (!resolved.startsWith(root)) return false;
    try {
      return !lstatSync(resolved).isSymbolicLink();
    } catch { return false; }
  }

  private isDir(target: string): boolean {
    try { return lstatSync(target).isDirectory(); } catch { return false; }
  }
}
