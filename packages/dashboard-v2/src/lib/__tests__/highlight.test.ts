import { describe, it, expect } from 'vitest';
import { renderFindingMarkdown } from '../utils';
import { highlightToHtml, normalizeLang } from '../highlight';

// ---------------------------------------------------------------------------
// normalizeLang — alias + charset sanitization
// ---------------------------------------------------------------------------
describe('normalizeLang', () => {
  it('resolves common aliases to canonical registered names', () => {
    expect(normalizeLang('ts')).toBe('typescript');
    expect(normalizeLang('js')).toBe('javascript');
    expect(normalizeLang('sh')).toBe('bash');
    expect(normalizeLang('shell')).toBe('bash');
    expect(normalizeLang('html')).toBe('xml');
    expect(normalizeLang('yml')).toBe('yaml');
  });

  it('strips hostile chars so an opener cannot break out of the class attr', () => {
    // ts"><img onerror=x>  → only [a-z0-9+-] survive
    const out = normalizeLang('ts"><img onerror=x>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('"');
    expect(/^[a-z0-9+-]*$/.test(out)).toBe(true);
  });

  it('returns empty string for missing/empty token', () => {
    expect(normalizeLang(undefined)).toBe('');
    expect(normalizeLang('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// highlightToHtml — escape-safe in every codepath
// ---------------------------------------------------------------------------
describe('highlightToHtml', () => {
  it('highlights a registered language and emits hljs spans', () => {
    const out = highlightToHtml('const x = 1;', 'typescript');
    expect(out).toContain('hljs-');
  });

  it('escapes plain text for an unknown language (no hljs spans, no throw)', () => {
    const out = highlightToHtml('<b>not code</b>', 'qwerty');
    expect(out).not.toContain('hljs-');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toMatch(/<b>/);
  });
});

// ---------------------------------------------------------------------------
// renderFindingMarkdown — fenced code block rendering
// ---------------------------------------------------------------------------
describe('renderFindingMarkdown — code fences', () => {
  it('renders a ```ts fence with the highlighted pre/code shell + spans', () => {
    const out = renderFindingMarkdown('```ts\nconst x: number = 1;\n```');
    expect(out).toContain('<pre class="md-code-block"><code class="hljs language-typescript">');
    expect(out).toMatch(/<span class="hljs-[a-z_]+">/);
  });

  it('falls back to escaped plain text for an unknown lang (no spans, no error)', () => {
    const out = renderFindingMarkdown('```qwerty\nplain <stuff>\n```');
    expect(out).toContain('<pre class="md-code-block"><code class="hljs');
    expect(out).not.toContain('hljs-'); // no token spans
    expect(out).toContain('&lt;stuff&gt;');
  });

  // -------------------------------------------------------------------------
  // CRITICAL — XSS regression. The escape-first property must hold: any
  // user-controlled substring in the fence body must reach the DOM escaped.
  // -------------------------------------------------------------------------
  it('escapes an HTML/script payload inside a fence body (no executable tags)', () => {
    const out = renderFindingMarkdown(
      '```text\n<img src=x onerror=alert(1)>\n</script>\n```',
    );
    // No raw executable tags survive.
    expect(out).not.toMatch(/<img /);
    expect(out).not.toMatch(/<script/);
    // The dangerous chars are entity-escaped.
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;/script&gt;');
  });

  it('sanitizes a hostile fence opener so it cannot inject via the class attr', () => {
    const out = renderFindingMarkdown('```ts"><img onerror=x>\nconst a = 1;\n```');
    // No injected <img via the language-class attribute.
    expect(out).not.toMatch(/<img/);
    // The class attr only ever contains a sanitized [a-z0-9+-]* token.
    const m = out.match(/class="hljs(?: language-([a-z0-9+-]*))?"/);
    expect(m).not.toBeNull();
    if (m && m[1]) {
      expect(/^[a-z0-9+-]*$/.test(m[1])).toBe(true);
    }
  });

  it('cannot be tricked by a forged sentinel in the input', () => {
    // A user typing the marker char + HLJS0 must not resolve to a real fence;
    // the strip step removes any NUL before tokens are assigned.
    const forged = String.fromCharCode(0) + 'HLJS0' + String.fromCharCode(0);
    const out = renderFindingMarkdown(forged + '\n```ts\nconst a = 1;\n```');
    // Only the REAL fence becomes a code block; the forged token does not.
    const blocks = out.match(/<pre class="md-code-block">/g) || [];
    expect(blocks.length).toBe(1);
  });

  it('leaves an unclosed fence as plain (escaped) text, not a code block', () => {
    const out = renderFindingMarkdown('```ts\nconst a = 1; // never closed');
    expect(out).not.toContain('<pre class="md-code-block">');
    // The literal backticks survive as escaped/plain text rather than a block.
    expect(out).toContain('```ts');
  });

  it('separates two adjacent fences into two distinct code blocks', () => {
    const out = renderFindingMarkdown('```ts\nconst a = 1;\n```\n\n```js\nlet b = 2;\n```');
    const blocks = out.match(/<pre class="md-code-block">/g) || [];
    expect(blocks.length).toBe(2);
    expect(out).toContain('language-typescript');
    expect(out).toContain('language-javascript');
  });

  it('highlights a ```tsx fence via the typescript alias', () => {
    const out = renderFindingMarkdown('```tsx\nconst x: number = 1;\n```');
    expect(out).toContain('language-typescript');
    expect(out).toMatch(/<span class="hljs-[a-z_]+">/);
  });
});

// ---------------------------------------------------------------------------
// Regression guard — non-fence rendering unchanged by the refactor
// ---------------------------------------------------------------------------
describe('renderFindingMarkdown — non-fence pipeline unchanged', () => {
  it('renders inline code unchanged', () => {
    const out = renderFindingMarkdown('use `npm run build` here');
    expect(out).toContain('<code class="md-inline-code">npm run build</code>');
  });

  it('renders headings and lists unchanged', () => {
    const out = renderFindingMarkdown('## Title\n- one\n- two');
    expect(out).toContain('<h2 class="md-h2">Title</h2>');
    expect(out).toContain('<ul class="md-list">');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<li>two</li>');
  });

  it('renders cite tags unchanged', () => {
    const out = renderFindingMarkdown('<cite tag="file">src/lib/utils.ts:145</cite>');
    expect(out).toContain('<code class="cite-file">src/lib/utils.ts:145</code>');
  });

  it('still escapes raw HTML outside fences (escape-first preserved)', () => {
    const out = renderFindingMarkdown('text <img src=x onerror=alert(1)> more');
    expect(out).not.toMatch(/<img /);
    expect(out).toContain('&lt;img');
  });
});
