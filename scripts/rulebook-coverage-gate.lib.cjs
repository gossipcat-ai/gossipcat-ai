// CommonJS library for scripts/rulebook-coverage-gate.mjs.
// Pure functions only — no I/O at import time. Kept as .cjs so both the ESM
// CLI wrapper and ts-jest tests can load it without needing Jest's
// experimental ESM mode.

'use strict';

/**
 * Returns signal names that are NOT covered by docs AND NOT in the exempt set.
 * "Covered by docs" means: the signal name appears as a substring of docsText
 * (backtick-wrapped names in markdown count because the name IS a substring of `name`).
 *
 * @param {string[]} signalNames
 * @param {string} docsText — concatenated contents of all operator docs
 * @param {Set<string>} exemptSet — signals explicitly exempted with a reason in the gate
 * @returns {string[]} — signal names that are undocumented and not exempt
 */
function findUndocumentedSignals(signalNames, docsText, exemptSet) {
  return signalNames.filter((name) => {
    if (exemptSet.has(name)) return false;
    return !docsText.includes(name);
  });
}

/**
 * Given the text of consensus-types.ts, extracts all string literals
 * inside the `OPERATIONAL_SIGNAL_NAMES = new Set([ ... ])` block.
 * Ignores comment content.
 *
 * @param {string} sourceText
 * @returns {string[]}
 */
function extractOperationalSignalNames(sourceText) {
  // Find the start of the OPERATIONAL_SIGNAL_NAMES block
  const markerIdx = sourceText.indexOf('OPERATIONAL_SIGNAL_NAMES');
  if (markerIdx === -1) return [];

  const afterMarker = sourceText.slice(markerIdx);

  // Find `new Set([`
  const setStart = afterMarker.indexOf('new Set([');
  if (setStart === -1) return [];

  const afterSetStart = afterMarker.slice(setStart + 'new Set(['.length);

  // Find the matching `])`
  let depth = 1;
  let i = 0;
  while (i < afterSetStart.length && depth > 0) {
    if (afterSetStart[i] === '[') depth++;
    else if (afterSetStart[i] === ']') depth--;
    i++;
  }
  const block = afterSetStart.slice(0, i - 1);

  // Strip /* ... */ comments
  const noBlockComments = block.replace(/\/\*[\s\S]*?\*\//g, '');

  // Strip // ... line comments
  const noLineComments = noBlockComments.replace(/\/\/[^\n]*/g, '');

  // Extract all single- or double-quoted string literals
  const names = [];
  const tokenRe = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = tokenRe.exec(noLineComments)) !== null) {
    names.push(m[1]);
  }
  return names;
}

module.exports = { findUndocumentedSignals, extractOperationalSignalNames };
