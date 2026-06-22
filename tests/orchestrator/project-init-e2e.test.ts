/**
 * Project Init E2E Test
 *
 * Verifies that ProjectInitializer correctly:
 * 1. Scans a directory with game signals
 * 2. Proposes a game-dev team via real LLM
 * 3. Returns a valid team proposal
 *
 * Run: npx jest tests/orchestrator/project-init-e2e.test.ts --testTimeout=120000 --verbose
 */
import { ProjectInitializer } from '../../packages/orchestrator/src/project-initializer';
import { createProvider } from '../../packages/orchestrator/src';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

function getKeyFromKeychain(provider: string): string | null {
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w'
    ], { stdio: 'pipe' }).toString().trim();
  } catch {
    return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || null;
  }
}

describe('Project Init E2E', () => {
  let testDir: string;
  let initializer: ProjectInitializer;

  beforeAll(() => {
    const apiKey = getKeyFromKeychain('google');
    if (!apiKey) throw new Error('Need Google API key for E2E test');

    const llm = createProvider('google', 'gemini-2.5-pro', apiKey);

    // Create temp project dir with game signals
    testDir = join(tmpdir(), `gossip-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'assets'), { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'snake-game',
      dependencies: { 'blessed': '^0.1.0' },
      devDependencies: { 'typescript': '^5.0.0' },
    }));
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');

    initializer = new ProjectInitializer({
      llm,
      projectRoot: testDir,
      keyProvider: async (provider) => getKeyFromKeychain(provider),
    });
  });

  afterAll(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should scan directory and detect game signals', () => {
    const signals = initializer.scanDirectory(testDir);
    console.log('Signals:', JSON.stringify(signals, null, 2));

    expect(signals.language).toBe('TypeScript');
    expect(signals.dependencies).toContain('blessed');
    expect(signals.directories).toContain('assets/');
    expect(signals.files).toContain('package.json');
  });

  it('should propose a game-dev team from real LLM', async () => {
    const signals = initializer.scanDirectory(testDir);
    const result = await initializer.proposeTeam(
      'Build a terminal snake game in TypeScript with keyboard input and score tracking',
      signals,
    );

    console.log('\n=== Team Proposal ===');
    console.log(result.text);

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(50);
    // Should have choices for approval
    expect(result.choices).toBeDefined();
  }, 60_000);

  it('should write config after approval', async () => {
    // Only run if proposeTeam stored a proposal
    if (!initializer.pendingProposal) {
      // Re-run proposeTeam to populate pendingProposal
      const signals = initializer.scanDirectory(testDir);
      await initializer.proposeTeam(
        'Build a terminal snake game in TypeScript',
        signals,
      );
    }

    if (initializer.pendingProposal) {
      await initializer.writeConfig(testDir);

      const configPath = join(testDir, '.gossip', 'config.json');
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      console.log('\n=== Written Config ===');
      console.log(JSON.stringify(config, null, 2));

      expect(config.project).toBeDefined();
      expect(config.project.archetype).toBeTruthy();
      expect(config.agents).toBeDefined();
      expect(Object.keys(config.agents).length).toBeGreaterThan(0);
    } else {
      console.log('Skipped: no pending proposal (LLM may have asked for clarification)');
    }
  }, 60_000);
});
