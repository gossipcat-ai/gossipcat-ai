/**
 * ConsensusJudge — post-consensus verification of confirmed findings.
 * Uses a dedicated LLM call (not a worker) to check if confirmed findings
 * are factually accurate against the actual codebase.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { ILLMProvider } from './llm-client';
import { ConsensusFinding } from './consensus-types';
import { LLMMessage } from '@gossip/types';

const log = (msg: string) => process.stderr.write(`[consensus-judge] ${msg}\n`);

export interface JudgeVerdict {
  index: number;
  verdict: 'VERIFIED' | 'REFUTED' | 'UNVERIFIABLE';
  evidence: string;
}

export interface IConsensusJudge {
  verify(confirmed: ConsensusFinding[]): Promise<JudgeVerdict[]>;
}

export class ConsensusJudge implements IConsensusJudge {
  constructor(
    private readonly llm: ILLMProvider,
    private readonly projectRoot: string,
  ) {}

  async verify(confirmed: ConsensusFinding[]): Promise<JudgeVerdict[]> {
    if (confirmed.length === 0) return [];

    // Build findings list with cited code snippets
    const findingLines: string[] = [];
    for (let i = 0; i < confirmed.length; i++) {
      const f = confirmed[i];
      const safeFinding = f.finding.replace(/<\/?confirmed_findings>/gi, '');
      let codeSnippet = '';

      const citMatch = safeFinding.match(/(?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,4}):(\d+)/);
      if (citMatch) {
        const snippet = this.readCodeSnippet(citMatch[1], parseInt(citMatch[2], 10));
        if (snippet) codeSnippet = `\n   Code at ${citMatch[1]}:${citMatch[2]}:\n   ${snippet}`;
      }

      findingLines.push(`${i + 1}. [agent: ${f.originalAgentId}] "${safeFinding}"${codeSnippet}`);
    }

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a code verification judge. Your ONLY job is to check whether confirmed findings about code are factually accurate. You are NOT reviewing the code — you are verifying other agents' claims.

For each finding, check the code snippet provided and determine if the claim is true.

Be skeptical. Agents frequently:
- Claim code "does not validate" when validation exists nearby
- Cite line numbers that don't match their claim
- Describe regex/logic incorrectly (confuse whitelist with blacklist)
- Say something is "missing" when it exists in a different form

Return ONLY a JSON array. No other text.`,
      },
      {
        role: 'user',
        content: `Verify these confirmed findings:

<confirmed_findings>
${findingLines.join('\n')}
</confirmed_findings>

For each, return: [{"index": 1, "verdict": "VERIFIED|REFUTED|UNVERIFIABLE", "evidence": "brief reason"}]`,
      },
    ];

    try {
      const response = await this.llm.generate(messages, { temperature: 0 });
      const text = response.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log('Judge returned no JSON array');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as JudgeVerdict[];
      return parsed.filter(v =>
        typeof v.index === 'number' &&
        typeof v.evidence === 'string' &&
        ['VERIFIED', 'REFUTED', 'UNVERIFIABLE'].includes(v.verdict)
      );
    } catch (err) {
      log(`Judge failed: ${(err as Error).message}`);
      return [];
    }
  }

  private readCodeSnippet(fileRef: string, line: number): string | null {
    const fileName = fileRef.split('/').pop()!;
    let filePath: string | null = null;

    const direct = join(this.projectRoot, fileRef);
    if (existsSync(direct)) {
      filePath = direct;
    } else {
      for (const dir of ['packages', 'src', 'apps']) {
        const found = this.findFileSync(join(this.projectRoot, dir), fileName);
        if (found) { filePath = found; break; }
      }
    }

    if (!filePath) return null;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      if (line > lines.length) return null;
      const start = Math.max(0, line - 4);
      const end = Math.min(lines.length, line + 6);
      return lines.slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n   ');
    } catch { return null; }
  }

  private findFileSync(dir: string, fileName: string): string | null {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) return fullPath;
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          const found = this.findFileSync(fullPath, fileName);
          if (found) return found;
        }
      }
    } catch { /* dir doesn't exist */ }
    return null;
  }
}
