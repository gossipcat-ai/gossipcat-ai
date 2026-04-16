import {
  parseAgentFindingsStrict,
  PARSE_FINDINGS_LIMITS,
} from '@gossip/orchestrator';

describe('parseAgentFindingsStrict', () => {
  describe('canonical types', () => {
    it('parses type="finding" / "suggestion" / "insight"', () => {
      const raw = `
<agent_finding type="finding" severity="high">Missing Secure cookie flag at routes.ts:126</agent_finding>
<agent_finding type="suggestion">Consider changing SameSite=Lax to SameSite=Strict</agent_finding>
<agent_finding type="insight">Session tokens use 256-bit entropy — sufficient</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(3);
      expect(res.findings.map(f => f.type)).toEqual(['finding', 'suggestion', 'insight']);
      expect(res.findings[0].severity).toBe('high');
      expect(res.findings[1].severity).toBeUndefined();
      expect(res.findings[2].severity).toBeUndefined();
      expect(res.droppedShortContent).toBe(0);
      expect(res.droppedMissingType).toBe(0);
      expect(Object.keys(res.droppedUnknownType)).toHaveLength(0);
    });

    it('attaches findingIdx sequentially (1-based)', () => {
      const raw = `
<agent_finding type="finding" severity="high">First finding content here</agent_finding>
<agent_finding type="finding" severity="low">Second finding content here</agent_finding>
<agent_finding type="insight">Third finding content here</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings.map(f => f.findingIdx)).toEqual([1, 2, 3]);
    });

    it('applies idPrefix to produce agentId:fN ids', () => {
      const raw = `<agent_finding type="finding" severity="high">First finding content here</agent_finding>
<agent_finding type="suggestion">Second finding content here</agent_finding>`;
      const res = parseAgentFindingsStrict(raw, { idPrefix: 'sonnet-reviewer' });
      expect(res.findings.map(f => f.id)).toEqual([
        'sonnet-reviewer:f1',
        'sonnet-reviewer:f2',
      ]);
    });

    it('falls back to f<N> when no idPrefix is supplied', () => {
      const raw = `<agent_finding type="finding" severity="high">Some finding content here</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings[0].id).toBe('f1');
    });
  });

  describe('unknown types', () => {
    const UNKNOWN_TYPES = [
      'approval',
      'concern',
      'risk',
      'recommendation',
      'confirmed',
      'issue',
      'bug',
      'warning',
      'verdict',
    ];

    it.each(UNKNOWN_TYPES)('drops + counts type="%s"', (type) => {
      const raw = `<agent_finding type="${type}" severity="high">Some finding with enough content here</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.droppedUnknownType[type]).toBe(1);
      expect(res.rawTagCount).toBe(1);
    });

    it('fires onUnknownType callback once per drop with lowercased type', () => {
      const raw = `
<agent_finding type="approval" severity="high">First dropped tag here content</agent_finding>
<agent_finding type="Approval" severity="low">Second dropped tag here content</agent_finding>
<agent_finding type="concern">Third dropped tag here content</agent_finding>
`;
      const calls: Array<{ type: string; body: string }> = [];
      const res = parseAgentFindingsStrict(raw, {
        onUnknownType: (type, body) => calls.push({ type, body }),
      });
      expect(res.findings).toHaveLength(0);
      expect(calls).toHaveLength(3);
      // Normalized to lowercase in both the callback and the counter
      expect(calls.map(c => c.type)).toEqual(['approval', 'approval', 'concern']);
      expect(res.droppedUnknownType).toEqual({ approval: 2, concern: 1 });
      expect(calls[0].body).toContain('First dropped tag');
    });

    it('does not advance findingIdx on drops — accepted tags keep sequential ids', () => {
      const raw = `
<agent_finding type="approval" severity="high">Dropped tag content here one</agent_finding>
<agent_finding type="finding" severity="high">Accepted tag content here one</agent_finding>
<agent_finding type="concern">Dropped tag content here two</agent_finding>
<agent_finding type="finding" severity="low">Accepted tag content here two</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw, { idPrefix: 'agent' });
      expect(res.findings.map(f => f.id)).toEqual(['agent:f1', 'agent:f2']);
      expect(res.findings.map(f => f.findingIdx)).toEqual([1, 2]);
      expect(res.droppedUnknownType).toEqual({ approval: 1, concern: 1 });
    });
  });

  describe('type attribute syntax', () => {
    it('accepts case-insensitive type value (type="FINDING")', () => {
      const raw = `<agent_finding type="FINDING" severity="high">Uppercase type value content</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0].type).toBe('finding');
    });

    it('accepts mixed-case type value (type="Suggestion")', () => {
      const raw = `<agent_finding type="Suggestion">Mixed case type value content</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0].type).toBe('suggestion');
    });

    it('drops typos (type="findng")', () => {
      const raw = `<agent_finding type="findng" severity="high">Typo in type attribute content</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.droppedUnknownType.findng).toBe(1);
    });

    it('drops tags with missing type attribute', () => {
      const raw = `<agent_finding severity="high">Missing type attribute content here</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.droppedMissingType).toBe(1);
      expect(Object.keys(res.droppedUnknownType)).toHaveLength(0);
    });

    it("drops single-quoted type (type='finding') — stays strict on quote style", () => {
      const raw = `<agent_finding type='finding' severity="high">Single-quoted type attribute content</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      // No type= double-quoted pattern matched → treated as missing.
      expect(res.droppedMissingType).toBe(1);
    });

    it('drops tags with whitespace around "=" (type = "finding")', () => {
      const raw = `<agent_finding type = "finding" severity="high">Whitespace around equals content</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.droppedMissingType).toBe(1);
    });
  });

  describe('content length', () => {
    it('drops content < 15 chars + counts it', () => {
      const raw = `
<agent_finding type="finding" severity="high">too short</agent_finding>
<agent_finding type="finding" severity="high">just long enough content</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.droppedShortContent).toBe(1);
      expect(res.rawTagCount).toBe(2);
    });

    it('drops empty content', () => {
      const raw = `<agent_finding type="finding" severity="high"></agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.droppedShortContent).toBe(1);
    });

    it('truncates content over MAX_FINDING_CONTENT and fires onTruncated', () => {
      const long = 'x'.repeat(PARSE_FINDINGS_LIMITS.MAX_FINDING_CONTENT + 500);
      const raw = `<agent_finding type="finding" severity="high">${long}</agent_finding>`;
      let truncatedLen = -1;
      const res = parseAgentFindingsStrict(raw, {
        onTruncated: (rawLength) => { truncatedLen = rawLength; },
      });
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0].truncated).toBe(true);
      expect(res.findings[0].content.length).toBeGreaterThan(PARSE_FINDINGS_LIMITS.MAX_FINDING_CONTENT);
      expect(res.findings[0].content).toMatch(/\[truncated\]$/);
      expect(truncatedLen).toBe(PARSE_FINDINGS_LIMITS.MAX_FINDING_CONTENT + 500);
    });
  });

  describe('malformed input', () => {
    it('ignores unclosed tags without crashing', () => {
      const raw = `<agent_finding type="finding" severity="high">never closed content here`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.rawTagCount).toBe(0);
    });

    it('ignores malformed tag with missing closing angle bracket', () => {
      const raw = `<agent_finding type="finding" severity="high"content never closes`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
    });

    it('round-trips nested angle brackets in content (e.g., generics)', () => {
      const raw = `<agent_finding type="finding" severity="high">Map<string, Array<number>> should be Record instead at foo.ts:10</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0].content).toContain('Map<string, Array<number>>');
    });

    it('handles multi-line attribute body — pinned current behavior (same-line attrs only)', () => {
      // Attributes on one line, content spans multiple lines: should parse.
      const raw = `<agent_finding type="finding" severity="high">
Multi-line body with cite tag="file">foo.ts:12</cite>
and a second paragraph.
</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0].content).toContain('foo.ts:12');
      expect(res.findings[0].content).toContain('second paragraph');
    });

    it('still parses when attribute line has extra whitespace before >', () => {
      const raw = `<agent_finding type="finding" severity="high" >Content with trailing attr whitespace</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
    });
  });

  describe('severity + category extraction', () => {
    it('extracts severity when present', () => {
      const raw = `
<agent_finding type="finding" severity="critical">Critical severity content</agent_finding>
<agent_finding type="finding" severity="high">High severity content here</agent_finding>
<agent_finding type="finding" severity="medium">Medium severity content here</agent_finding>
<agent_finding type="finding" severity="low">Low severity content here</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings.map(f => f.severity)).toEqual([
        'critical', 'high', 'medium', 'low',
      ]);
    });

    it('leaves severity undefined when attribute missing or invalid', () => {
      const raw = `
<agent_finding type="finding">No severity attribute content</agent_finding>
<agent_finding type="finding" severity="urgent">Invalid severity value content</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(2);
      expect(res.findings[0].severity).toBeUndefined();
      expect(res.findings[1].severity).toBeUndefined();
    });

    it('extracts lowercase category attribute', () => {
      const raw = `<agent_finding type="finding" severity="high" category="type_safety">Content with category</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings[0].category).toBe('type_safety');
    });
  });

  describe('hasAnchor detection', () => {
    it('detects file:line anchors in content', () => {
      const raw = `<agent_finding type="finding" severity="high">Bug at src/foo.ts:42 in handler</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings[0].hasAnchor).toBe(true);
    });

    it('returns false when no file:line anchor is present', () => {
      const raw = `<agent_finding type="finding" severity="high">Generic observation without a citation</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings[0].hasAnchor).toBe(false);
    });
  });

  describe('HTML entity diagnostics', () => {
    it('emits no diagnostic for a clean raw-tag-only payload', () => {
      const raw = `<agent_finding type="finding" severity="high">Raw tag at foo.ts:12 content</agent_finding>`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.diagnostics).toEqual([]);
    });

    it('emits HTML_ENTITY_ENCODED_TAGS when output is entity-encoded only', () => {
      // `<agent_finding type="finding" severity="high">body at foo.ts:12</agent_finding>`
      // escaped to entity form. The parser cannot see tags → 0 findings, but
      // the diagnostic MUST fire loudly.
      const raw =
        `&lt;agent_finding type="finding" severity="high"&gt;body at foo.ts:12 some content&lt;/agent_finding&gt;`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.rawTagCount).toBe(0);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].code).toBe('HTML_ENTITY_ENCODED_TAGS');
      if (res.diagnostics[0].code === 'HTML_ENTITY_ENCODED_TAGS') {
        expect(res.diagnostics[0].entityTagCount).toBe(1);
        // The message must mention the failure mode so the dashboard banner is
        // self-explanatory without the dashboard having to compose prose.
        expect(res.diagnostics[0].message).toMatch(/entity-encoded/i);
      }
    });

    it('emits HTML_ENTITY_MIXED_PAYLOAD when raw + entity-encoded tags mix', () => {
      const raw = `
<agent_finding type="finding" severity="high">raw visible tag foo.ts:10 content</agent_finding>
&lt;agent_finding type="finding" severity="high"&gt;hidden entity-encoded tag bar.ts:20&lt;/agent_finding&gt;
`;
      const res = parseAgentFindingsStrict(raw);
      // Raw tag parses, entity-encoded one silently drops (but the diagnostic fires).
      expect(res.findings).toHaveLength(1);
      expect(res.rawTagCount).toBe(1);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].code).toBe('HTML_ENTITY_MIXED_PAYLOAD');
      if (res.diagnostics[0].code === 'HTML_ENTITY_MIXED_PAYLOAD') {
        expect(res.diagnostics[0].rawTagCount).toBe(1);
        expect(res.diagnostics[0].entityTagCount).toBe(1);
      }
    });

    it("XSS sanitizer smoke test: diagnostic message survives literal `<script>` escape path", () => {
      // Pathological input: entity-encoded tag whose content includes a raw
      // `<script>` payload. The diagnostic message returned by the parser
      // must NOT contain an unescaped `<script>` tag — escaping happens at
      // the dashboard render layer (`escapeHtml` in packages/dashboard-v2/src/lib/sanitize.ts),
      // but the parser itself MUST NOT include the attacker-controlled tag body
      // in the diagnostic message at all.
      const raw =
        `&lt;agent_finding type="finding" severity="high"&gt;<script>alert("xss")</script>&lt;/agent_finding&gt;`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].code).toBe('HTML_ENTITY_ENCODED_TAGS');
      // The diagnostic message summarizes the failure mode; it must not reflect
      // the raw script payload into its text.
      expect(res.diagnostics[0].message).not.toContain('<script>');
      expect(res.diagnostics[0].message).not.toContain('alert(');
    });
  });

  describe('counters', () => {
    it('reports rawTagCount regardless of drop reasons', () => {
      const raw = `
<agent_finding type="finding" severity="high">accepted content here ok</agent_finding>
<agent_finding type="approval" severity="high">dropped unknown type content</agent_finding>
<agent_finding type="finding" severity="high">tiny</agent_finding>
<agent_finding severity="high">missing type attribute content</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.rawTagCount).toBe(4);
      expect(res.findings).toHaveLength(1);
      expect(res.droppedUnknownType).toEqual({ approval: 1 });
      expect(res.droppedShortContent).toBe(1);
      expect(res.droppedMissingType).toBe(1);
    });
  });

  // Schema-drift diagnostics — see docs/specs/2026-04-16-schema-drift-diagnostic.md
  // Six cases mandated by the spec's "Validation" section.
  describe('schema drift diagnostics', () => {
    it('emits no drift diagnostic when all types are valid', () => {
      // Spec validation case #1.
      const raw = `
<agent_finding type="finding" severity="high">Anchored at foo.ts:12 valid content</agent_finding>
<agent_finding type="suggestion">Consider refactoring this logic</agent_finding>
<agent_finding type="insight">Observation about the codebase shape</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(3);
      // No SCHEMA_DRIFT_* diagnostic should appear — a clean round stays silent.
      const driftCodes = res.diagnostics
        .map(d => d.code)
        .filter(c => c.startsWith('SCHEMA_DRIFT_'));
      expect(driftCodes).toEqual([]);
    });

    it('fires SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS when `type="confirmed"` is dropped with zero accepted', () => {
      // Spec validation case #2. Full-drift: reviewer emitted Phase-2 verdict
      // format and nothing parsed.
      const raw = `
<agent_finding type="confirmed" severity="high">Legacy verdict format at foo.ts:10</agent_finding>
<agent_finding type="disputed" severity="high">Another legacy verdict bar.ts:20</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      const phase2 = res.diagnostics.find(d => d.code === 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS');
      expect(phase2).toBeDefined();
      if (phase2 && phase2.code === 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS') {
        // matchedTokens contains both drifted tokens, lowercased.
        expect(phase2.matchedTokens.sort()).toEqual(['confirmed', 'disputed']);
        // The message must name the Phase-2 verdict framing for the operator.
        expect(phase2.message).toMatch(/Phase-2/);
        expect(phase2.message).toContain('confirmed');
        expect(phase2.message).toContain('disputed');
      }
    });

    it('fires SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS on partial drift (some valid, some Phase-2 tokens)', () => {
      // Spec validation case #3. Partial-drift: the diagnostic STILL fires
      // even though some tags parsed successfully — per consensus round
      // 2c0c1e0b-66cf4919:f10, partial-drift is in scope.
      const raw = `
<agent_finding type="finding" severity="high">Valid finding content at foo.ts:10</agent_finding>
<agent_finding type="confirmed" severity="high">Drifted Phase-2 verdict format</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.rawTagCount).toBe(2);
      const phase2 = res.diagnostics.find(d => d.code === 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS');
      expect(phase2).toBeDefined();
      if (phase2 && phase2.code === 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS') {
        expect(phase2.matchedTokens).toEqual(['confirmed']);
      }
    });

    it('fires SCHEMA_DRIFT_INVENTED_TYPE_TOKENS when only invented tokens are dropped', () => {
      // Spec validation case #4. No Phase-2 overlap → invented fires.
      const raw = `
<agent_finding type="risk" severity="high">Security risk identified bar.ts:30</agent_finding>
<agent_finding type="bug" severity="high">Bug at foo.ts:40 some content</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      const invented = res.diagnostics.find(d => d.code === 'SCHEMA_DRIFT_INVENTED_TYPE_TOKENS');
      expect(invented).toBeDefined();
      if (invented && invented.code === 'SCHEMA_DRIFT_INVENTED_TYPE_TOKENS') {
        expect(invented.matchedTokens.sort()).toEqual(['bug', 'risk']);
        expect(invented.message).toContain('finding | suggestion | insight');
      }
      // Phase-2 diagnostic MUST NOT fire when no verdict tokens present.
      expect(
        res.diagnostics.find(d => d.code === 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS'),
      ).toBeUndefined();
    });

    it('only fires SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS when both verdict AND invented tokens present (precedence)', () => {
      // Spec validation case #5. Phase-2 takes precedence because it points
      // to a specific known regression (legacy prompt).
      const raw = `
<agent_finding type="confirmed" severity="high">Phase-2 verdict format at foo.ts:10</agent_finding>
<agent_finding type="risk" severity="high">Invented type at bar.ts:20</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      const codes = res.diagnostics.map(d => d.code);
      expect(codes).toContain('SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS');
      expect(codes).not.toContain('SCHEMA_DRIFT_INVENTED_TYPE_TOKENS');
    });

    it('fires SCHEMA_DRIFT_NESTED_SUBTAGS when droppedMissingType > 0 and <type> subtags present', () => {
      // Spec validation case #6. Nested-subtag drift hits droppedMissingType
      // (not droppedUnknownType) because the outer tag has no `type="..."`
      // attribute.
      const raw = `
<agent_finding severity="high"><type>finding</type>Body with anchor foo.ts:50</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(0);
      expect(res.droppedMissingType).toBe(1);
      const nested = res.diagnostics.find(d => d.code === 'SCHEMA_DRIFT_NESTED_SUBTAGS');
      expect(nested).toBeDefined();
      if (nested && nested.code === 'SCHEMA_DRIFT_NESTED_SUBTAGS') {
        expect(nested.subtagTypes).toEqual(['finding']);
        // Message names the attribute-form fix.
        expect(nested.message).toMatch(/attribute form/);
      }
    });

    it('does NOT fire SCHEMA_DRIFT_NESTED_SUBTAGS when droppedMissingType is 0 (even if <type> prose appears)', () => {
      // Guard: the nested-subtag regex only runs when there's actually a
      // missing-type drop. A raw string containing `<type>foo</type>` prose
      // outside any <agent_finding> tag must not trigger.
      const raw = `
<agent_finding type="finding" severity="high">Doc says <type>finding</type> is the canonical type at foo.ts:10</agent_finding>
`;
      const res = parseAgentFindingsStrict(raw);
      expect(res.findings).toHaveLength(1);
      expect(res.droppedMissingType).toBe(0);
      expect(
        res.diagnostics.find(d => d.code === 'SCHEMA_DRIFT_NESTED_SUBTAGS'),
      ).toBeUndefined();
    });
  });
});
