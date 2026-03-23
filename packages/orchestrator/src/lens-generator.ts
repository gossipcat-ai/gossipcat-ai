import type { ILLMProvider } from './llm-client';
import type { LLMMessage } from '@gossip/types';
import type { LensAssignment } from './types';

const STOP_WORDS = new Set(['the', 'a', 'an', 'on', 'in', 'for', 'and', 'or', 'to', 'of', 'is', 'do', 'not', 'focus']);

export class LensGenerator {
  constructor(private llm: ILLMProvider) {}

  async generateLenses(
    agents: Array<{ id: string; preset: string; skills: string[] }>,
    task: string,
    sharedSkills: string[],
  ): Promise<LensAssignment[]> {
    if (agents.length < 2 || sharedSkills.length === 0) return [];

    const agentList = agents.map(a => `- ${a.id} (${a.preset}): skills=[${a.skills.join(', ')}]`).join('\n');
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are assigning review focuses to ${agents.length} agents working on the same task.
Each agent should have a UNIQUE focus that avoids duplicating another's work.
Consider their presets and skills when assigning focus areas.

Agents:
${agentList}

Shared skills: ${sharedSkills.join(', ')}

Return a JSON array of { "agentId": string, "focus": string, "avoidOverlap": string } for each agent.
Return ONLY the JSON array, no other text.`,
      },
      { role: 'user', content: `Task: ${task}` },
    ];

    try {
      const response = await this.llm.generate(messages, { temperature: 0.3 });
      const text = (response.text || '').trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as LensAssignment[];
      if (!Array.isArray(parsed)) return [];
      const valid = parsed.filter(l => l.agentId && l.focus);
      if (valid.length !== agents.length) return [];
      if (!this.areDifferentiated(valid)) return [];
      return valid;
    } catch {
      return [];
    }
  }

  private areDifferentiated(lenses: LensAssignment[]): boolean {
    for (let i = 0; i < lenses.length; i++) {
      for (let j = i + 1; j < lenses.length; j++) {
        const wordsA = this.significantWords(lenses[i].focus);
        const wordsB = this.significantWords(lenses[j].focus);
        const intersection = wordsA.filter(w => wordsB.includes(w));
        const minLen = Math.min(wordsA.length, wordsB.length);
        if (minLen > 0 && intersection.length / minLen > 0.5) return false;
      }
    }
    return true;
  }

  private significantWords(text: string): string[] {
    return text.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }
}
