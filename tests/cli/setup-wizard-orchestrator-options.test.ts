import { buildOrchestratorOptions } from '../../apps/cli/src/setup-wizard-options';

describe('buildOrchestratorOptions', () => {
  it('always puts "none" (native host orchestration) first', () => {
    const options = buildOrchestratorOptions(['anthropic', 'openai']);
    expect(options[0]).toEqual({
      value: 'none',
      label: 'None — native host orchestration',
      hint: 'no API key needed; recommended inside Claude Code / Cursor',
    });
  });

  it('appends one entry per configured provider, using PROVIDERS labels', () => {
    const options = buildOrchestratorOptions(['anthropic', 'openai', 'google']);
    expect(options.map(o => o.value)).toEqual(['none', 'anthropic', 'openai', 'google']);
    expect(options.find(o => o.value === 'anthropic')?.label).toBe('Anthropic (Claude)');
    expect(options.find(o => o.value === 'openai')?.label).toBe('OpenAI (GPT)');
    expect(options.find(o => o.value === 'google')?.label).toBe('Google (Gemini)');
  });

  it('labels the "local" provider as "Local (Ollama)"', () => {
    const options = buildOrchestratorOptions(['local']);
    expect(options).toEqual([
      {
        value: 'none',
        label: 'None — native host orchestration',
        hint: 'no API key needed; recommended inside Claude Code / Cursor',
      },
      { value: 'local', label: 'Local (Ollama)' },
    ]);
  });

  it('returns only the "none" option when no providers are configured', () => {
    const options = buildOrchestratorOptions([]);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('none');
  });
});
