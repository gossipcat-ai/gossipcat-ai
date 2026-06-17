import { useMemo, useState } from 'react';
import type { AnswerResponse, PendingQuestion } from '@/lib/useBridge';

/**
 * QuestionCard — renders an outstanding gossip_ask question round inline in the
 * Transcript (dashboard-answerable parallel to the terminal-only AskUserQuestion).
 *
 * Per question:
 *   - a header (small-caps) + prompt
 *   - single-select RADIOS (multiSelect=false) or multi-select CHECKBOXES
 *   - an "Other" free-text input when allowOther
 * A NEUTRAL Submit button (NOT --accent — terracotta is Send-only) posts the
 * answer; the parent optimistically renders the choice as a user turn and clears
 * the card. Submit is disabled until EVERY question has a selection (or, when
 * allowOther, non-empty Other text).
 *
 * DESIGN.md dark carve-out: hairline --border, --r-md radius, no shadows, --info
 * (teal) for any selection highlight — never --accent. a11y: fieldset/legend per
 * question, labelled radio/checkbox groups, focus-visible rings, reduced-motion.
 */

interface QuestionCardProps {
  pending: PendingQuestion;
  /** Submit the answer; resolves true on accept. */
  onSubmit: (responses: AnswerResponse[]) => Promise<boolean>;
  /** True while a submit is in flight (locks the controls). */
  submitting?: boolean;
}

/** Local per-question answer state. */
interface Draft {
  selected: string[];
  other: string;
}

export function QuestionCard({ pending, onSubmit, submitting = false }: QuestionCardProps) {
  // One draft per question, keyed by questionId. Initialized empty.
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const init: Record<string, Draft> = {};
    for (const q of pending.questions) init[q.questionId] = { selected: [], other: '' };
    return init;
  });
  const [busy, setBusy] = useState(false);
  const locked = busy || submitting;

  const draftFor = (qid: string): Draft => drafts[qid] ?? { selected: [], other: '' };

  const setSelectedSingle = (qid: string, label: string) => {
    setDrafts((prev) => ({ ...prev, [qid]: { ...draftFor(qid), selected: [label] } }));
  };
  const toggleSelectedMulti = (qid: string, label: string) => {
    setDrafts((prev) => {
      const d = prev[qid] ?? { selected: [], other: '' };
      const has = d.selected.includes(label);
      const selected = has ? d.selected.filter((s) => s !== label) : [...d.selected, label];
      return { ...prev, [qid]: { ...d, selected } };
    });
  };
  const setOther = (qid: string, other: string) => {
    setDrafts((prev) => ({ ...prev, [qid]: { ...draftFor(qid), other } }));
  };

  // Every question must yield at least one signal: a selected label, OR (when the
  // question allows it) non-empty Other text.
  const complete = useMemo(
    () =>
      pending.questions.every((q) => {
        const d = drafts[q.questionId] ?? { selected: [], other: '' };
        const hasOther = q.allowOther === true && d.other.trim().length > 0;
        return d.selected.length > 0 || hasOther;
      }),
    [pending.questions, drafts]
  );

  const handleSubmit = async () => {
    if (!complete || locked) return;
    const responses: AnswerResponse[] = pending.questions.map((q) => {
      const d = drafts[q.questionId] ?? { selected: [], other: '' };
      const r: AnswerResponse = { questionId: q.questionId, selected: d.selected };
      if (q.allowOther === true && d.other.trim().length > 0) r.other = d.other.trim();
      return r;
    });
    setBusy(true);
    try {
      await onSubmit(responses);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cx-qcard" role="group" aria-label="Question from the live session">
      {pending.questions.map((q) => {
        const d = draftFor(q.questionId);
        const multi = q.multiSelect === true;
        const groupName = `q-${pending.qid}-${q.questionId}`;
        return (
          <fieldset key={q.questionId} className="cx-qfield">
            <legend className="cx-qlegend">{q.header}</legend>
            <p className="cx-qprompt">{q.question}</p>
            <div className="cx-qoptions" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
              {q.options.map((o) => {
                const checked = d.selected.includes(o.label);
                return (
                  <label key={o.label} className={`cx-qopt${checked ? ' is-selected' : ''}`}>
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name={groupName}
                      value={o.label}
                      checked={checked}
                      disabled={locked}
                      onChange={() =>
                        multi ? toggleSelectedMulti(q.questionId, o.label) : setSelectedSingle(q.questionId, o.label)
                      }
                      className="cx-qinput"
                    />
                    <span className="cx-qopt-body">
                      <span className="cx-qopt-label">{o.label}</span>
                      {o.description && <span className="cx-qopt-desc">{o.description}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            {q.allowOther === true && (
              <label className="cx-qother">
                <span className="cx-qother-label">Other</span>
                <input
                  type="text"
                  value={d.other}
                  disabled={locked}
                  placeholder="type a different answer…"
                  onChange={(e) => setOther(q.questionId, e.target.value)}
                  className="cx-qother-input"
                  aria-label={`Other answer for ${q.header}`}
                />
              </label>
            )}
          </fieldset>
        );
      })}
      <div className="cx-qactions">
        <button
          type="button"
          className="cx-qsubmit"
          onClick={handleSubmit}
          disabled={!complete || locked}
          aria-label="Submit answer"
        >
          {locked ? 'submitting…' : 'Submit answer'}
        </button>
      </div>
    </div>
  );
}
