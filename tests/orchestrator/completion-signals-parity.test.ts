/**
 * Layer 1 signal-pipeline drift guard.
 *
 * Parses packages/orchestrator/src/completion-signals.ts with the TypeScript
 * Compiler API (already a devDep; ts-morph is not installed and was flagged
 * rather than added unilaterally). Extracts every string literal assigned
 * to a property named `signal` inside the helper's exported function bodies,
 * then compares the set against the committed allowlist.
 *
 * A mismatch in EITHER direction fails — new signals must be allowlisted,
 * and removed signals must be pruned from the allowlist.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { COMPLETION_SIGNAL_ALLOWLIST } from '../../packages/orchestrator/src/completion-signals.allowlist';

const HELPER_PATH = join(
  __dirname,
  '../../packages/orchestrator/src/completion-signals.ts',
);

interface ExtractedSignal {
  name: string;
  line: number;
  column: number;
}

function extractSignalsFromHelper(filePath: string): ExtractedSignal[] {
  const source = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const found: ExtractedSignal[] = [];

  // Walk only named function declarations at module top-level. This scopes
  // extraction to the helper's own function bodies and ignores anything
  // imported or referenced from elsewhere.
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  function visit(node: ts.Node): void {
    // Match: { signal: 'literal', ... }
    if (ts.isPropertyAssignment(node)) {
      const nameNode = node.name;
      const keyName = ts.isIdentifier(nameNode)
        ? nameNode.text
        : ts.isStringLiteral(nameNode)
          ? nameNode.text
          : undefined;
      if (keyName === 'signal' && ts.isStringLiteral(node.initializer)) {
        const pos = sf.getLineAndCharacterOfPosition(node.initializer.getStart(sf));
        found.push({
          name: node.initializer.text,
          line: pos.line + 1,
          column: pos.character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  return found;
}

describe('completion-signals parity (Layer 1 drift guard)', () => {
  it('helper emissions exactly match COMPLETION_SIGNAL_ALLOWLIST', () => {
    const extracted = extractSignalsFromHelper(HELPER_PATH);
    const codeSet = new Set(extracted.map(s => s.name));
    const allowSet = new Set(COMPLETION_SIGNAL_ALLOWLIST);

    const addedInCode = [...codeSet].filter(s => !allowSet.has(s));
    const orphanedInAllowlist = [...allowSet].filter(s => !codeSet.has(s));

    if (addedInCode.length > 0 || orphanedInAllowlist.length > 0) {
      const lines: string[] = ['Signal allowlist drift detected:'];
      if (addedInCode.length > 0) {
        lines.push('  new signal added — update allowlist:');
        for (const name of addedInCode) {
          const locs = extracted
            .filter(s => s.name === name)
            .map(s => `completion-signals.ts:${s.line}:${s.column}`)
            .join(', ');
          lines.push(`    - ${name} (at ${locs})`);
        }
      }
      if (orphanedInAllowlist.length > 0) {
        lines.push('  signal removed — prune allowlist:');
        for (const name of orphanedInAllowlist) {
          lines.push(`    - ${name}`);
        }
      }
      throw new Error(lines.join('\n'));
    }

    expect(codeSet).toEqual(allowSet);
  });
});
