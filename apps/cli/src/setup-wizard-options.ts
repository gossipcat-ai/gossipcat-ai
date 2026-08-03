// ── Provider + Model catalog ────────────────────────────────────────────────
// Extracted from setup-wizard.ts into its own module (no @clack/prompts
// import) so pure helpers here stay unit-testable without an ESM-transform
// jest config change. setup-wizard.ts imports PROVIDERS / ProviderKey /
// buildOrchestratorOptions from here.
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    hint: 'claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5',
    models: [
      { value: 'claude-opus-4-6',   label: 'Claude Opus 4.6',   hint: 'Most capable, highest cost' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',  hint: 'Fast + smart — recommended' },
      { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',   hint: 'Fastest, lowest cost' },
    ],
  },
  openai: {
    label: 'OpenAI (GPT)',
    hint: 'gpt-5, gpt-4o, o3, o3-mini',
    models: [
      { value: 'gpt-5',      label: 'GPT-5',       hint: 'Most capable' },
      { value: 'gpt-4o',     label: 'GPT-4o',      hint: 'Fast + smart — recommended' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini', hint: 'Fastest, lowest cost' },
      { value: 'o3',         label: 'o3',           hint: 'Reasoning model' },
      { value: 'o3-mini',    label: 'o3-mini',      hint: 'Fast reasoning' },
    ],
  },
  google: {
    label: 'Google (Gemini)',
    hint: 'gemini-2.5-pro, gemini-2.5-flash',
    models: [
      { value: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',   hint: 'Most capable' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'Fast — recommended' },
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', hint: 'Previous gen, stable' },
    ],
  },
} as const;

export type ProviderKey = keyof typeof PROVIDERS | 'local';

/**
 * Builds the Step 3 orchestrator select options: "none" (native host
 * orchestration) always first, followed by one entry per configured
 * provider. Pure helper — no prompt I/O — so it can be unit-tested directly.
 */
export function buildOrchestratorOptions(
  configuredProviders: ProviderKey[]
): Array<{ value: string; label: string; hint?: string }> {
  const options: Array<{ value: string; label: string; hint?: string }> = [
    {
      value: 'none',
      label: 'None — native host orchestration',
      hint: 'no API key needed; recommended inside Claude Code / Cursor',
    },
  ];

  for (const provider of configuredProviders) {
    const label = provider === 'local' ? 'Local (Ollama)' : PROVIDERS[provider as keyof typeof PROVIDERS].label;
    options.push({ value: provider, label });
  }

  return options;
}
