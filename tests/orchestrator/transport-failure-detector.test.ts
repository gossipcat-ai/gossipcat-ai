/**
 * transport-failure-detector tests — Path 2 mitigation for the relay-worker
 * resolutionRoots plumbing gap. Spec:
 * docs/specs/2026-04-29-relay-worker-resolution-roots.md.
 *
 * Covers the five canonical cases from the dispatch task:
 *   (a) hallucination_caught against native agent → NOT rewritten
 *   (b) hallucination_caught against relay agent + resolutionRoots
 *       + matching pattern → rewritten
 *   (c) hallucination_caught against relay agent + resolutionRoots
 *       BUT non-matching text → NOT rewritten
 *   (d) hallucination_caught against relay agent WITHOUT resolutionRoots
 *       → NOT rewritten
 *   (e) audit log preserves original signal so retraction is reversible
 */

import {
  shouldRewriteToTransportFailure,
  maybeRewriteHallucinationToTransportFailure,
  appendTransportRewrite,
  lookupRoundResolutionRoots,
  extractConsensusId,
  TRANSPORT_FAILURE_PATTERN,
} from '../../packages/orchestrator/src/transport-failure-detector';
import type { ConsensusSignal } from '../../packages/orchestrator/src/consensus-types';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-transport-failure-detector');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

function writeReport(consensusId: string, body: Record<string, unknown>): void {
  const dir = join(TEST_DIR, '.gossip', 'consensus-reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${consensusId}.json`), JSON.stringify(body));
}

function readAuditLog(): Array<Record<string, unknown>> {
  const path = join(TEST_DIR, '.gossip', 'transport-rewrites.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function makeHallucinationSignal(overrides: Partial<ConsensusSignal> = {}): ConsensusSignal {
  return {
    type: 'consensus',
    signal: 'hallucination_caught',
    taskId: 't-1',
    consensusId: '328adef4-087942f7',
    findingId: '328adef4-087942f7:gemini-reviewer:f1',
    agentId: 'gemini-reviewer',
    evidence: 'Files are not present in the provided worktree',
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ConsensusSignal;
}

describe('TRANSPORT_FAILURE_PATTERN', () => {
  it('matches the canonical relay-worker error phrasings', () => {
    const cases = [
      'Files are not present in the provided worktree',
      'The core feature files are missing',
      'git diff reports empty diff for the specified commit',
      'empty workspace at the cited path',
      'cannot be read from disk',
      'cannot be located on disk',
      'not found on disk',
      'not present in the worktree',
      'not present on the filesystem',
    ];
    for (const text of cases) {
      expect(TRANSPORT_FAILURE_PATTERN.test(text)).toBe(true);
    }
  });

  it('does not match unrelated hallucination text', () => {
    const cases = [
      'XSS vulnerability in template renderer',
      'unbounded loop on user input',
      'race condition between A and B',
      'function returns wrong type at line 42',
    ];
    for (const text of cases) {
      expect(TRANSPORT_FAILURE_PATTERN.test(text)).toBe(false);
    }
  });
});

describe('shouldRewriteToTransportFailure', () => {
  const baseCtx = {
    isNativeAgent: false,
    hadResolutionRoots: true,
    findingText: 'Files are not present in the provided worktree',
  };

  it('case (a): native agent → does NOT rewrite', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        isNativeAgent: true,
      }),
    ).toBe(false);
  });

  it('case (b): relay agent + resolutionRoots + matching text → rewrites', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', baseCtx),
    ).toBe(true);
  });

  it('case (c): relay agent + resolutionRoots + non-matching text → does NOT rewrite', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        findingText: 'XSS vulnerability in renderUserBio',
      }),
    ).toBe(false);
  });

  it('case (d): relay agent + matching text + NO resolutionRoots → does NOT rewrite', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        hadResolutionRoots: false,
      }),
    ).toBe(false);
  });

  it('only fires for hallucination_caught — agreement / unique_confirmed pass through', () => {
    for (const sig of ['agreement', 'unique_confirmed', 'disagreement', 'task_empty']) {
      expect(shouldRewriteToTransportFailure(sig, baseCtx)).toBe(false);
    }
  });

  it('returns false on empty findingText', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        findingText: '',
      }),
    ).toBe(false);
  });

  // PR #327 sonnet review CRITICAL #1 — cite-anchor co-presence veto.
  it('cite-anchor co-presence vetoes the rewrite (preserve as hallucination)', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        findingText:
          'feature flag file is missing — see <cite tag="file">config/flags.ts:12</cite>',
      }),
    ).toBe(false);
  });

  it('matching text WITHOUT a cite anchor still rewrites', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        findingText: 'files are not present in the worktree',
      }),
    ).toBe(true);
  });

  it('cite anchor with single quotes is also detected', () => {
    expect(
      shouldRewriteToTransportFailure('hallucination_caught', {
        ...baseCtx,
        findingText:
          "files are missing — <cite tag='file'>src/x.ts:1</cite>",
      }),
    ).toBe(false);
  });
});

describe('extractConsensusId', () => {
  it('parses the bulk shape <consensus_id>:fN', () => {
    expect(extractConsensusId('328adef4-087942f7:f1')).toBe('328adef4-087942f7');
  });

  it('parses the manual shape <consensus_id>:<agent>:fN', () => {
    expect(extractConsensusId('328adef4-087942f7:gemini-reviewer:f1')).toBe(
      '328adef4-087942f7',
    );
  });

  it('returns undefined on missing input', () => {
    expect(extractConsensusId(undefined)).toBeUndefined();
    expect(extractConsensusId('')).toBeUndefined();
  });

  it('returns undefined on malformed prefix', () => {
    expect(extractConsensusId('not-a-consensus-id:f1')).toBeUndefined();
    expect(extractConsensusId('xxxxxxxx-xxxxxxxx:f1')).toBeUndefined();
  });
});

describe('lookupRoundResolutionRoots', () => {
  it('returns empty array when the report does not exist', () => {
    expect(lookupRoundResolutionRoots(TEST_DIR, 'aaaaaaaa-bbbbbbbb')).toEqual([]);
  });

  it('returns the roots array when the report has one', () => {
    writeReport('aaaaaaaa-bbbbbbbb', {
      id: 'aaaaaaaa-bbbbbbbb',
      resolutionRoots: ['/abs/path/to/worktree'],
    });
    expect(lookupRoundResolutionRoots(TEST_DIR, 'aaaaaaaa-bbbbbbbb')).toEqual([
      '/abs/path/to/worktree',
    ]);
  });

  it('returns empty array when resolutionRoots is missing or non-array', () => {
    writeReport('cccccccc-dddddddd', { id: 'cccccccc-dddddddd' });
    expect(lookupRoundResolutionRoots(TEST_DIR, 'cccccccc-dddddddd')).toEqual([]);
  });
});

describe('appendTransportRewrite — case (e) audit preserves original signal', () => {
  it('appends a row containing original_signal so retraction can replay it', () => {
    appendTransportRewrite(TEST_DIR, {
      ts: '2026-04-29T12:00:00.000Z',
      consensus_id: '328adef4-087942f7',
      finding_id: '328adef4-087942f7:gemini-reviewer:f1',
      agent_id: 'gemini-reviewer',
      original_signal: 'hallucination_caught',
      rewritten_to: 'transport_failure',
      finding_excerpt: 'Files are not present in the provided worktree',
    });
    const rows = readAuditLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      original_signal: 'hallucination_caught',
      rewritten_to: 'transport_failure',
      consensus_id: '328adef4-087942f7',
      finding_id: '328adef4-087942f7:gemini-reviewer:f1',
      agent_id: 'gemini-reviewer',
    });
  });
});

describe('maybeRewriteHallucinationToTransportFailure — end-to-end', () => {
  const RELAY_AGENT = 'gemini-reviewer';
  const NATIVE_AGENT = 'sonnet-reviewer';
  const isNative = (id: string): boolean => id === NATIVE_AGENT;

  it('case (b): rewrites when ALL preconditions hold', () => {
    writeReport('328adef4-087942f7', {
      id: '328adef4-087942f7',
      resolutionRoots: ['/some/worktree'],
    });
    const sig = makeHallucinationSignal({ agentId: RELAY_AGENT });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('transport_failure');
    expect(out.agentId).toBe(RELAY_AGENT);
    // Audit log written
    const rows = readAuditLog();
    expect(rows).toHaveLength(1);
    expect(rows[0].original_signal).toBe('hallucination_caught');
  });

  it('case (a): does NOT rewrite for native agent', () => {
    writeReport('328adef4-087942f7', {
      id: '328adef4-087942f7',
      resolutionRoots: ['/some/worktree'],
    });
    const sig = makeHallucinationSignal({ agentId: NATIVE_AGENT });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('hallucination_caught');
    expect(readAuditLog()).toHaveLength(0);
  });

  it('case (c): does NOT rewrite when text does not match the pattern', () => {
    writeReport('328adef4-087942f7', {
      id: '328adef4-087942f7',
      resolutionRoots: ['/some/worktree'],
    });
    const sig = makeHallucinationSignal({
      agentId: RELAY_AGENT,
      evidence: 'XSS vulnerability in renderUserBio at handlers/user.ts:42',
    });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('hallucination_caught');
    expect(readAuditLog()).toHaveLength(0);
  });

  it('case (d): does NOT rewrite when consensus round had no resolutionRoots', () => {
    writeReport('328adef4-087942f7', {
      id: '328adef4-087942f7',
      resolutionRoots: [],
    });
    const sig = makeHallucinationSignal({ agentId: RELAY_AGENT });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('hallucination_caught');
    expect(readAuditLog()).toHaveLength(0);
  });

  it('returns input unchanged for non-hallucination signals', () => {
    const sig = makeHallucinationSignal({
      signal: 'agreement',
      agentId: RELAY_AGENT,
    } as Partial<ConsensusSignal>);
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out).toBe(sig);
  });

  // PR #327 sonnet review HIGH #3 — coalesce evidence + finding fields.
  it('coalesces signal.finding into the pattern check when evidence is unrelated', () => {
    writeReport('328adef4-087942f7', {
      id: '328adef4-087942f7',
      resolutionRoots: ['/some/worktree'],
    });
    const sig = makeHallucinationSignal({
      agentId: RELAY_AGENT,
      evidence: 'unrelated noise',
      // ConsensusSignal nominally has no `finding`, but recordSignals callers
      // pass through a divergent `finding` field; the detector must coalesce.
      finding: 'files are not present in the provided worktree',
    } as Partial<ConsensusSignal> & { finding?: string });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('transport_failure');
  });

  // PR #327 sonnet review CRITICAL #1 — cite-anchor veto end-to-end.
  it('preserves hallucination_caught when finding carries a cite anchor', () => {
    writeReport('328adef4-087942f7', {
      id: '328adef4-087942f7',
      resolutionRoots: ['/some/worktree'],
    });
    const sig = makeHallucinationSignal({
      agentId: RELAY_AGENT,
      evidence:
        'feature flag file is missing — see <cite tag="file">config/flags.ts:12</cite>',
    });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('hallucination_caught');
    expect(readAuditLog()).toHaveLength(0);
  });

  it('returns input unchanged when consensus_id cannot be derived', () => {
    const sig = makeHallucinationSignal({
      agentId: RELAY_AGENT,
      findingId: undefined,
      consensusId: undefined,
    });
    const out = maybeRewriteHallucinationToTransportFailure(TEST_DIR, sig, isNative);
    expect(out.signal).toBe('hallucination_caught');
    expect(readAuditLog()).toHaveLength(0);
  });
});
