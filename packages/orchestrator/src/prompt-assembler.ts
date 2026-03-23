/**
 * Assemble memory, lens, skills, context, and gossip into a single prompt string.
 * Order: CHAIN CONTEXT → SESSION CONTEXT → MEMORY → LENS → SKILLS → context
 * Each block is only included if content is provided.
 */
export function assemblePrompt(parts: {
  memory?: string;
  lens?: string;
  skills?: string;
  context?: string;
  sessionContext?: string;
  chainContext?: string;
  consensusSummary?: boolean;
}): string {
  const blocks: string[] = [];

  if (parts.chainContext) {
    blocks.push(`\n\n${parts.chainContext}`);
  }

  if (parts.sessionContext) {
    blocks.push(`\n\n${parts.sessionContext}`);
  }

  if (parts.memory) {
    blocks.push(`\n\n--- MEMORY ---\n${parts.memory}\n--- END MEMORY ---`);
  }

  if (parts.lens) {
    blocks.push(`\n\n--- LENS ---\n${parts.lens}\n--- END LENS ---`);
  }

  if (parts.consensusSummary) {
    blocks.push(`\n\n--- CONSENSUS OUTPUT FORMAT ---
End your response with a section titled "## Consensus Summary".
List one line per finding with file:line references where applicable.
Format: "- <finding description> (file:line)"
This section will be used for cross-review with peer agents.
--- END CONSENSUS OUTPUT FORMAT ---`);
  }

  if (parts.skills) {
    blocks.push(`\n\n--- SKILLS ---\n${parts.skills}\n--- END SKILLS ---`);
  }

  if (parts.context) {
    blocks.push(`\n\nContext:\n${parts.context}`);
  }

  return blocks.join('');
}
