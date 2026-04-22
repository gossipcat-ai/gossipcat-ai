/**
 * Premise verification — Stage 2 claim schema (PR A).
 *
 * JSON schema emitted by investigation skills inside a fenced
 * ```premise-claims``` block and consumed by `claim-verifier.ts`
 * at the dispatch boundary. See
 * `docs/specs/2026-04-22-premise-verification-stage-2.md` §Claim schema.
 *
 * Pure types + fail-soft parser. No I/O, no process spawns.
 */

export type Modality = 'asserted' | 'hedged' | 'vague';

export type Relation = '>' | '<' | '=' | '≥' | '≤';

export interface CallsiteCountClaim {
  type: 'callsite_count';
  symbol: string;
  scope: string;
  expected: number;
  modality: Modality;
  negated?: boolean;
  /** Used when modality === 'vague' to express a min/max observation window. */
  range_hint?: { min: number; max: number };
}

export interface FileLineClaim {
  type: 'file_line';
  path: string;
  line: number;
  expected_symbol: string;
  modality: Modality;
  negated?: boolean;
}

export interface AbsenceOfSymbolClaim {
  type: 'absence_of_symbol';
  symbol: string;
  scope: string;
  /** Free-text reviewer hint; max 120 chars per spec §Claim types. */
  context: string;
  modality: Modality;
  // `negated: true` is illegal for absence_of_symbol — that's presence_of_symbol.
}

export interface PresenceOfSymbolClaim {
  type: 'presence_of_symbol';
  symbol: string;
  scope: string;
  modality: Modality;
  negated?: boolean;
}

export interface CountRelationClaim {
  type: 'count_relation';
  symbol: string;
  scope: string;
  relation: Relation;
  value: number;
  modality: Modality;
  negated?: boolean;
}

export type Claim =
  | CallsiteCountClaim
  | FileLineClaim
  | AbsenceOfSymbolClaim
  | PresenceOfSymbolClaim
  | CountRelationClaim;

export interface ClaimBlock {
  schema_version: '1';
  verifier: 'orchestrator';
  claims: Claim[];
}

export type ClaimVerdict =
  | { claim_index: number; status: 'verified' }
  | {
      claim_index: number;
      status: 'falsified';
      observed: unknown;
      expected: unknown;
      modality: Modality;
    }
  | { claim_index: number; status: 'unverifiable_by_grep'; reason: string };

export interface ParseError {
  /** Null when the outer JSON/shape is invalid and no claim index applies. */
  claim_index: number | null;
  message: string;
}

export interface ParseClaimBlockResult {
  block: ClaimBlock | null;
  errors: ParseError[];
}

const VALID_MODALITIES: Modality[] = ['asserted', 'hedged', 'vague'];
const VALID_RELATIONS: Relation[] = ['>', '<', '=', '≥', '≤'];
const MAX_CONTEXT_CHARS = 120;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validateModality(raw: unknown, errors: ParseError[], idx: number): Modality {
  if (raw === undefined) {
    errors.push({ claim_index: idx, message: 'missing_modality' });
    return 'asserted';
  }
  if (typeof raw === 'string' && (VALID_MODALITIES as string[]).includes(raw)) {
    return raw as Modality;
  }
  errors.push({ claim_index: idx, message: `invalid_modality: ${String(raw)}` });
  return 'asserted';
}

function validateClaim(raw: unknown, idx: number, errors: ParseError[]): Claim | null {
  if (!isObject(raw)) {
    errors.push({ claim_index: idx, message: 'claim_not_object' });
    return null;
  }
  const t = raw.type;
  if (typeof t !== 'string') {
    errors.push({ claim_index: idx, message: 'missing_type' });
    return null;
  }

  const modality = validateModality(raw.modality, errors, idx);

  switch (t) {
    case 'callsite_count': {
      if (typeof raw.symbol !== 'string' || raw.symbol.length === 0) {
        errors.push({ claim_index: idx, message: 'callsite_count: symbol must be non-empty string' });
        return null;
      }
      if (typeof raw.scope !== 'string' || raw.scope.length === 0) {
        errors.push({ claim_index: idx, message: 'callsite_count: scope must be non-empty string' });
        return null;
      }
      if (typeof raw.expected !== 'number' || !Number.isInteger(raw.expected)) {
        errors.push({ claim_index: idx, message: 'callsite_count: expected must be integer' });
        return null;
      }
      const out: CallsiteCountClaim = {
        type: 'callsite_count',
        symbol: raw.symbol,
        scope: raw.scope,
        expected: raw.expected,
        modality,
      };
      if (raw.negated === true) out.negated = true;
      if (isObject(raw.range_hint)) {
        const { min, max } = raw.range_hint;
        if (
          typeof min === 'number' && Number.isInteger(min) &&
          typeof max === 'number' && Number.isInteger(max) &&
          min <= max
        ) {
          out.range_hint = { min, max };
        } else {
          errors.push({ claim_index: idx, message: 'range_hint: min/max must be integers with min <= max' });
        }
      }
      return out;
    }
    case 'file_line': {
      if (typeof raw.path !== 'string' || raw.path.length === 0) {
        errors.push({ claim_index: idx, message: 'file_line: path must be non-empty string' });
        return null;
      }
      if (typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 1) {
        errors.push({ claim_index: idx, message: 'file_line: line must be positive integer' });
        return null;
      }
      if (typeof raw.expected_symbol !== 'string' || raw.expected_symbol.length === 0) {
        errors.push({ claim_index: idx, message: 'file_line: expected_symbol must be non-empty string' });
        return null;
      }
      const out: FileLineClaim = {
        type: 'file_line',
        path: raw.path,
        line: raw.line,
        expected_symbol: raw.expected_symbol,
        modality,
      };
      if (raw.negated === true) out.negated = true;
      return out;
    }
    case 'absence_of_symbol': {
      if (typeof raw.symbol !== 'string' || raw.symbol.length === 0) {
        errors.push({ claim_index: idx, message: 'absence_of_symbol: symbol must be non-empty string' });
        return null;
      }
      if (typeof raw.scope !== 'string' || raw.scope.length === 0) {
        errors.push({ claim_index: idx, message: 'absence_of_symbol: scope must be non-empty string' });
        return null;
      }
      if (typeof raw.context !== 'string') {
        errors.push({ claim_index: idx, message: 'absence_of_symbol: context must be string' });
        return null;
      }
      if (raw.context.length > MAX_CONTEXT_CHARS) {
        errors.push({ claim_index: idx, message: `absence_of_symbol: context exceeds ${MAX_CONTEXT_CHARS} chars` });
        return null;
      }
      if (raw.negated === true) {
        errors.push({
          claim_index: idx,
          message: 'absence_of_symbol + negated:true is illegal (use presence_of_symbol)',
        });
        return null;
      }
      return {
        type: 'absence_of_symbol',
        symbol: raw.symbol,
        scope: raw.scope,
        context: raw.context,
        modality,
      };
    }
    case 'presence_of_symbol': {
      if (typeof raw.symbol !== 'string' || raw.symbol.length === 0) {
        errors.push({ claim_index: idx, message: 'presence_of_symbol: symbol must be non-empty string' });
        return null;
      }
      if (typeof raw.scope !== 'string' || raw.scope.length === 0) {
        errors.push({ claim_index: idx, message: 'presence_of_symbol: scope must be non-empty string' });
        return null;
      }
      const out: PresenceOfSymbolClaim = {
        type: 'presence_of_symbol',
        symbol: raw.symbol,
        scope: raw.scope,
        modality,
      };
      if (raw.negated === true) out.negated = true;
      return out;
    }
    case 'count_relation': {
      if (typeof raw.symbol !== 'string' || raw.symbol.length === 0) {
        errors.push({ claim_index: idx, message: 'count_relation: symbol must be non-empty string' });
        return null;
      }
      if (typeof raw.scope !== 'string' || raw.scope.length === 0) {
        errors.push({ claim_index: idx, message: 'count_relation: scope must be non-empty string' });
        return null;
      }
      if (typeof raw.relation !== 'string' || !(VALID_RELATIONS as string[]).includes(raw.relation)) {
        errors.push({ claim_index: idx, message: `count_relation: relation must be one of ${VALID_RELATIONS.join(',')}` });
        return null;
      }
      if (typeof raw.value !== 'number' || !Number.isInteger(raw.value)) {
        errors.push({ claim_index: idx, message: 'count_relation: value must be integer' });
        return null;
      }
      const out: CountRelationClaim = {
        type: 'count_relation',
        symbol: raw.symbol,
        scope: raw.scope,
        relation: raw.relation as Relation,
        value: raw.value,
        modality,
      };
      if (raw.negated === true) out.negated = true;
      return out;
    }
    default:
      errors.push({ claim_index: idx, message: `unknown_type: ${t}` });
      return null;
  }
}

/**
 * Fail-soft parser — malformed outer JSON returns `{ block: null, errors }`.
 * Individual bad claims are skipped; remaining valid claims are kept.
 */
export function parseClaimBlock(rawJson: string): ParseClaimBlockResult {
  const errors: ParseError[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { block: null, errors: [{ claim_index: null, message: 'invalid_json' }] };
  }
  if (!isObject(parsed)) {
    return { block: null, errors: [{ claim_index: null, message: 'not_an_object' }] };
  }
  if (parsed.schema_version !== '1') {
    errors.push({ claim_index: null, message: `unsupported_schema_version: ${String(parsed.schema_version)}` });
  }
  if (parsed.verifier !== 'orchestrator') {
    errors.push({ claim_index: null, message: `unexpected_verifier: ${String(parsed.verifier)}` });
  }
  if (!Array.isArray(parsed.claims)) {
    return {
      block: null,
      errors: [...errors, { claim_index: null, message: 'claims_not_array' }],
    };
  }

  const claims: Claim[] = [];
  for (let i = 0; i < parsed.claims.length; i++) {
    const c = validateClaim(parsed.claims[i], i, errors);
    if (c) claims.push(c);
  }

  const block: ClaimBlock = {
    schema_version: '1',
    verifier: 'orchestrator',
    claims,
  };
  return { block, errors };
}
