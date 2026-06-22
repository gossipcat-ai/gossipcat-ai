import { MemoryWriter } from '@gossip/orchestrator';
import { rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MemoryWriter Edge Cases', () => {
  const testDir = join(tmpdir(), `gossip-memwriter-edge-test-${Date.now()}`);
  const agentId = 'test-agent-edge';
  const memDir = join(testDir, '.gossip', 'agents', agentId, 'memory');
  const knowledgeDir = join(memDir, 'knowledge');

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Technology Regex', () => {
    it('should correctly match keywords with escaped dots like "next.js"', () => {
      const writer = new MemoryWriter(testDir);
      // This is an internal method, so we test it via its public caller
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'tech-1',
        task: 'review next.js app',
        result: 'The application uses next.js and node.js for the backend.',
      });

      const files = readdirSync(knowledgeDir).filter(f => f.includes('tech-1'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
      expect(content).toContain('Technology: next.js, node.js');
    });

    it('should not match partial words like "go" in "golang"', () => {
        const writer = new MemoryWriter(testDir);
        writer.writeKnowledgeFromResult(agentId, {
            taskId: 'tech-2',
            task: 'review golang server',
            result: 'This is a server written in golang.',
        });

        const files = readdirSync(knowledgeDir).filter(f => f.includes('tech-2'));
        const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
        // The regex for 'go' would match 'golang', but the explicit 'golang' keyword should be found.
        // The test ensures the word boundary logic is working.
        expect(content).toContain('Technology: golang');
        expect(content).not.toContain('go,');
    });
  });

  describe('Cognitive Summary Parsing', () => {
    const mockLlm = (text: string) => ({
        generate: jest.fn().mockResolvedValue({ text }),
    });

    it('should handle DESCRIPTION and TECHNOLOGIES in any order', async () => {
        const writer = new MemoryWriter(testDir);
        writer.setSummaryLlm(mockLlm('You found a bug.\nTECHNOLOGIES: typescript\nDESCRIPTION: A simple bug'));

        await writer.writeKnowledgeFromResult(agentId, { taskId: 'llm-1', task: 'review src/index.ts', result: 'Found bug in src/index.ts with error handling.' });

        const files = readdirSync(knowledgeDir).filter(f => f.includes('llm-1'));
        const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
        expect(content).toContain('description: A simple bug');
        expect(content).toContain('Technology: typescript');
    });

    it('should handle missing DESCRIPTION, using regex fallback', async () => {
        const writer = new MemoryWriter(testDir);
        writer.setSummaryLlm(mockLlm('You found a bug in src/index.ts.\nTECHNOLOGIES: typescript'));

        await writer.writeKnowledgeFromResult(agentId, { taskId: 'llm-2', task: 'review src/index.ts', result: 'Found a critical bug in src/index.ts with authentication bypass.' });

        const files = readdirSync(knowledgeDir).filter(f => f.includes('llm-2'));
        const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
        expect(content).toContain('description: Found a critical bug in src/index.ts with authentication bypass'); // Fallback: first sentence
        expect(content).toContain('Technology: typescript');
    });

    it('should handle extra whitespace and markdown in values', async () => {
        const writer = new MemoryWriter(testDir);
        writer.setSummaryLlm(mockLlm('Summary.\nDESCRIPTION:   A bug was found.  \nTECHNOLOGIES: *typescript*, `jest`'));

        await writer.writeKnowledgeFromResult(agentId, { taskId: 'llm-3', task: 'review src/app.ts', result: 'Reviewed src/app.ts and found several issues with the validation logic.' });

        const files = readdirSync(knowledgeDir).filter(f => f.includes('llm-3'));
        const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
        expect(content).toContain('description: A bug was found.');
        // Note: It does NOT sanitize markdown, this test confirms current behavior.
        expect(content).toContain('Technology: *typescript*, `jest`');
    });

    it('should parse DESCRIPTION on the very first line of LLM output', async () => {
        const writer = new MemoryWriter(testDir);
        writer.setSummaryLlm(mockLlm('DESCRIPTION: First-line description\nYou reviewed the auth module.\nTECHNOLOGIES: typescript'));

        await writer.writeKnowledgeFromResult(agentId, { taskId: 'llm-4', task: 'review src/auth.ts', result: 'Reviewed src/auth.ts and found token validation issues.' });

        const files = readdirSync(knowledgeDir).filter(f => f.includes('llm-4'));
        const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
        expect(content).toContain('description: First-line description');
        // DESCRIPTION line should be stripped from body
        expect(content).not.toMatch(/^DESCRIPTION:/m);
    });

    it('should handle large results without crashing', async () => {
        const writer = new MemoryWriter(testDir);
        const largeResult = 'Found issue in src/big-file.ts. '.repeat(2000); // ~60KB

        await writer.writeKnowledgeFromResult(agentId, { taskId: 'llm-5', task: 'review src/big-file.ts', result: largeResult });

        const files = readdirSync(knowledgeDir).filter(f => f.includes('llm-5'));
        expect(files.length).toBe(1);
        const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
        expect(content).toContain('src/big-file.ts');
    });
  });

  describe('Knowledge File Rotation', () => {
    it('should keep only the most recent MAX_KNOWLEDGE_FILES', () => {
        const writer = new MemoryWriter(testDir);
        const MAX_FILES = 25;

        // Create 30 files
        for (let i = 0; i < MAX_FILES + 5; i++) {
            const taskId = `rotate-${i.toString().padStart(2, '0')}`;
            writer.writeKnowledgeFromResult(agentId, { taskId, task: 'review src/file.ts', result: `Found issue in src/file-${i}.ts with error handling in the main module.` });
        }

        const files = readdirSync(knowledgeDir);
        // Warmth-based pruning: 5 lowest-warmth files evicted, 25 remain
        expect(files.length).toBe(MAX_FILES);
        // All files have identical importance/timestamp so eviction is by warmth (arbitrary among equals)
        // Just verify the newest file survived (it was written last, same warmth)
        const joined = files.join(' ');
        expect(joined).toContain(`rotate-${MAX_FILES + 4}`);
    });
  });

  describe('Project Memory Pruning', () => {
      it('should prune the least warm files and respect pinned entries', async () => {
        const writer = new MemoryWriter(testDir);
        const projectKnowledgeDir = join(testDir, '.gossip', 'agents', '_project', 'memory', 'knowledge');
        mkdirSync(projectKnowledgeDir, { recursive: true });

        // importance * (1 / (1 + days / 30))
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
        const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];

        // Warmth ~0.9
        writeFileSync(join(projectKnowledgeDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-high-imp-recent.md`), `---\nimportance: 0.9\nlastAccessed: ${today}\n---\n`);
        // Warmth ~0.45
        writeFileSync(join(projectKnowledgeDir, `${new Date(Date.now() - 30 * 86400000).toISOString().replace(/[:.]/g, '-')}-high-imp-old.md`), `---\nimportance: 0.9\nlastAccessed: ${thirtyDaysAgo}\n---\n`);
        // Warmth ~0.25
        writeFileSync(join(projectKnowledgeDir, `${new Date(Date.now() - 30 * 86400000).toISOString().replace(/[:.]/g, '-')}-low-imp-old.md`), `---\nimportance: 0.5\nlastAccessed: ${thirtyDaysAgo}\n---\n`);
        // Warmth ~0.16
        writeFileSync(join(projectKnowledgeDir, `${new Date(Date.now() - 60 * 86400000).toISOString().replace(/[:.]/g, '-')}-low-imp-very-old.md`), `---\nimportance: 0.5\nlastAccessed: ${sixtyDaysAgo}\n---\n`);
        // Pinned, Warmth: Infinity
        writeFileSync(join(projectKnowledgeDir, `${new Date(Date.now() - 60 * 86400000).toISOString().replace(/[:.]/g, '-')}-pinned.md`), `---\nimportance: 0.5\npinned: true\nlastAccessed: ${sixtyDaysAgo}\n---\n`);

        // Create 10 total files to trigger pruning (MAX is 10, so it will remove one to add a new one)
        for (let i = 0; i < 5; i++) {
             writeFileSync(join(projectKnowledgeDir, `${new Date(Date.now() - (40+i) * 86400000).toISOString().replace(/[:.]/g, '-')}-filler-${i}.md`), `---\nimportance: 0.5\nlastAccessed: ${thirtyDaysAgo}\n---\n`);
        }

        // This call will trigger pruning, which should remove the 1 file with the lowest warmth.
        await writer.writeSessionSummary({ gossip: 'g', consensus: 'c', performance: 'p', gitLog: 'gl' });

        const files = readdirSync(projectKnowledgeDir);
        expect(files.length).toBe(10);
        expect(files.some(f => f.includes('pinned'))).toBe(true);
        expect(files.some(f => f.includes('high-imp-recent'))).toBe(true);
        // This is the file that should have been pruned.
        expect(files.some(f => f.includes('low-imp-very-old'))).toBe(false);
      });
  });
});
