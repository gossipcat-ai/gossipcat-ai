/**
 * Tests for F13 hardening (consensus 20c17ac3-03bb4f25): the provisional
 * signal pipeline in handleCollect used to derive the consensus round ID
 * with `allFindings[0].id.split(':')[0]` without validating the shape.
 * Malformed first-finding IDs silently routed signals under the wrong ID.
 * These tests lock in the canonical validator + extractor.
 */
import {
  CONSENSUS_ID_RE,
  isValidConsensusId,
  extractConsensusIdFromFindingId,
} from '../../apps/cli/src/handlers/collect';

describe('CONSENSUS_ID_RE', () => {
  it('matches canonical <8hex>-<8hex> shape', () => {
    expect(CONSENSUS_ID_RE.test('0a7c34cb-91624bd4')).toBe(true);
    expect(CONSENSUS_ID_RE.test('abcdef01-23456789')).toBe(true);
  });

  it('rejects shorter or longer segments', () => {
    expect(CONSENSUS_ID_RE.test('0a7c34c-91624bd4')).toBe(false);
    expect(CONSENSUS_ID_RE.test('0a7c34cb1-91624bd4')).toBe(false);
    expect(CONSENSUS_ID_RE.test('0a7c34cb-91624bd')).toBe(false);
  });

  it('rejects uppercase / non-hex characters', () => {
    expect(CONSENSUS_ID_RE.test('0A7C34CB-91624BD4')).toBe(false);
    expect(CONSENSUS_ID_RE.test('0a7c34cg-91624bd4')).toBe(false);
    expect(CONSENSUS_ID_RE.test('0a7c34cb_91624bd4')).toBe(false);
  });
});

describe('isValidConsensusId', () => {
  it('accepts a valid consensus ID', () => {
    expect(isValidConsensusId('0a7c34cb-91624bd4')).toBe(true);
  });

  it('rejects non-string inputs', () => {
    expect(isValidConsensusId(undefined)).toBe(false);
    expect(isValidConsensusId(null)).toBe(false);
    expect(isValidConsensusId(42)).toBe(false);
    expect(isValidConsensusId({})).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isValidConsensusId('')).toBe(false);
    expect(isValidConsensusId('not-a-consensus-id')).toBe(false);
    expect(isValidConsensusId('12345')).toBe(false);
  });
});

describe('extractConsensusIdFromFindingId', () => {
  it('extracts the consensus ID from a modern three-segment finding ID', () => {
    expect(extractConsensusIdFromFindingId('0a7c34cb-91624bd4:sonnet-reviewer:f11')).toBe('0a7c34cb-91624bd4');
  });

  it('extracts the consensus ID from a legacy two-segment finding ID', () => {
    expect(extractConsensusIdFromFindingId('abcdef01-23456789:f1')).toBe('abcdef01-23456789');
  });

  it('returns undefined when the first segment is not a valid consensus ID', () => {
    expect(extractConsensusIdFromFindingId('not-an-id:agent-x:f1')).toBeUndefined();
    expect(extractConsensusIdFromFindingId('short:f1')).toBeUndefined();
    expect(extractConsensusIdFromFindingId('totally-freeform-finding')).toBeUndefined();
  });

  it('returns undefined for non-string inputs', () => {
    expect(extractConsensusIdFromFindingId(undefined)).toBeUndefined();
    expect(extractConsensusIdFromFindingId(null)).toBeUndefined();
    expect(extractConsensusIdFromFindingId(123)).toBeUndefined();
  });

  it('returns undefined when split yields a would-be-valid-looking but malformed segment', () => {
    // Missing dash in what would otherwise be an 8+8 hex prefix.
    expect(extractConsensusIdFromFindingId('0a7c34cb91624bd4:f1')).toBeUndefined();
  });
});
