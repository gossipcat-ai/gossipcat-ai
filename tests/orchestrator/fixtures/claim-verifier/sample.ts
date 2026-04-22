/* eslint-disable */
// @ts-nocheck
// Fixture for claim-verifier tests. Do NOT edit line numbers without updating
// claim-verifier.test.ts — file_line tests reference specific lines.
export function alpha() {
  return 'a';
}
export function beta() {
  return 'b';
}
// Line with two calls to `widget` on one line — tests that --count-matches
// counts 2 here, NOT 1 as `-c` would.
const pair = [widget(), widget()];

function widget() {
  return 1;
}

// gamma marker at line 18
function gamma() {
  return alpha() + beta();
}

export { pair, gamma };
