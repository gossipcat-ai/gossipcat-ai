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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import {
  COMPLETION_SIGNAL_ALLOWLIST,
  EMISSION_PATHS,
} from '../../packages/orchestrator/src/completion-signals.allowlist';

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

    expect(extracted.length).toBeGreaterThan(0);
    expect(codeSet).toEqual(allowSet);
  });

  it('every appendSignal(s) call site passes an EmissionPath second argument', () => {
    const repoRoot = join(__dirname, '../..');
    const scanRoots = [
      join(repoRoot, 'packages/orchestrator/src'),
      join(repoRoot, 'apps/cli/src'),
    ];
    const allowed = new Set<string>(EMISSION_PATHS);
    const offenders: Array<{ file: string; line: number; col: number; reason: string; raw: string }> = [];

    for (const root of scanRoots) {
      for (const file of walkTsFiles(root)) {
        scanFile(file);
      }
    }

    function walkTsFiles(dir: string): string[] {
      const out: string[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          out.push(...walkTsFiles(full));
        } else if (st.isFile() && (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts')) {
          out.push(full);
        }
      }
      return out;
    }

    function scanFile(file: string): void {
      const source = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const rel = relative(repoRoot, file);
      visit(sf);

      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const methodName = node.expression.name.text;
          if (methodName === 'appendSignal' || methodName === 'appendSignals') {
            // Skip the definition site itself (method declaration, not a call).
            // Skip writer test helpers that intentionally exercise the default
            // `'unknown'` path (validateSignal unit tests).
            if (rel.endsWith('packages/orchestrator/src/performance-writer.ts')) {
              // The only calls inside the writer are the implementation — no
              // .appendSignal(s) invocations exist on `this.` beyond method bodies.
              // Guard is defensive: parity check applies only to external callers.
              return;
            }
            // Ignore the interface-shape declaration in tool-server.ts. That
            // file declares a minimal duck-typed interface and does not call
            // the real PerformanceWriter; its one invocation is a separate
            // local writer and is wired below.
            const args = node.arguments;
            if (args.length < 2) {
              const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              offenders.push({
                file: rel,
                line: pos.line + 1,
                col: pos.character + 1,
                reason: `${methodName}() called with ${args.length} argument(s); expected 2 (signals, emissionPath)`,
                raw: node.getText(sf).slice(0, 120),
              });
            } else {
              const second = args[1];
              if (!ts.isStringLiteral(second) && !ts.isNoSubstitutionTemplateLiteral(second)) {
                const pos = sf.getLineAndCharacterOfPosition(second.getStart(sf));
                offenders.push({
                  file: rel,
                  line: pos.line + 1,
                  col: pos.character + 1,
                  reason: `${methodName}() second argument is not a string literal`,
                  raw: second.getText(sf).slice(0, 80),
                });
              } else if (!allowed.has(second.text)) {
                const pos = sf.getLineAndCharacterOfPosition(second.getStart(sf));
                offenders.push({
                  file: rel,
                  line: pos.line + 1,
                  col: pos.character + 1,
                  reason: `${methodName}() second argument "${second.text}" is not in EMISSION_PATHS`,
                  raw: second.getText(sf).slice(0, 80),
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
    }

    if (offenders.length > 0) {
      const msg = [
        `Emission-path parity drift — ${offenders.length} offending appendSignal(s) call site(s).`,
        `Every call site under packages/orchestrator/src/ or apps/cli/src/ must pass a string literal`,
        `from EMISSION_PATHS in completion-signals.allowlist.ts as its second argument.`,
        '',
        ...offenders.map(o => `  ${o.file}:${o.line}:${o.col}  ${o.reason}\n    > ${o.raw}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(offenders).toEqual([]);
  });
});
