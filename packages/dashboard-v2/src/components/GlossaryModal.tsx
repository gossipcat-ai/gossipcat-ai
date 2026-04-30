import { useEffect, useRef } from 'react';

interface GlossaryModalProps {
  open: boolean;
  onClose: () => void;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  seeAlso?: string;
}

const TERMS: GlossaryTerm[] = [
  {
    term: 'Consensus Round',
    definition:
      'A structured multi-agent review session. Each agent independently reviews the target code or output, then all agents cross-review each other\'s findings. The result is a set of findings tagged by how many agents agreed. The /debates URL in the dashboard lists all past consensus rounds.',
    seeAlso: 'Finding, Signal',
  },
  {
    term: 'Finding',
    definition:
      'A verifiable claim about a specific line of code, always cited with a file path and line number. Agents emit findings during a consensus round. A finding that cannot be located in the code is a hallucination.',
    seeAlso: 'Insight, Hallucination',
  },
  {
    term: 'Insight',
    definition:
      'An observation that does not point to a specific code location. Insights are informational — they cannot be confirmed or disputed by other agents and are excluded from accuracy scoring.',
    seeAlso: 'Finding',
  },
  {
    term: 'Signal',
    definition:
      'A scored event recorded against an agent, such as agreement, hallucination_caught, or unique_confirmed. Each signal adjusts the agent\'s accuracy and dispatch weight over time. Signals are the primary feedback mechanism that drives agent improvement.',
    seeAlso: 'Accuracy (Adjusted), Dispatch Weight',
  },
  {
    term: 'Hallucination',
    definition:
      'A fabricated finding: the cited file and line exist, but the code does not support the claim the agent made. Caught during cross-review by a peer agent. Each hallucination lowers the emitting agent\'s accuracy score.',
    seeAlso: 'Finding, Signal',
  },
  {
    term: 'Confirmed / Disputed / Unverified / Unique',
    definition:
      'The four statuses assigned to a finding after cross-review. Confirmed = two or more agents independently verified it. Disputed = at least one agent found contradictory evidence. Unverified = peer agents could not check it (no code anchor, out of scope). Unique = only one agent surfaced it; not yet confirmed or denied.',
    seeAlso: 'Consensus Round',
  },
  {
    term: 'Dispatch Weight',
    definition:
      'How likely an agent is to be selected for the next task. Ranges from 0.3 (rarely dispatched) to 2.0 (strongly preferred). Updated after every task based on accuracy and uniqueness signals. Visible on the Team page.',
    seeAlso: 'Accuracy (Adjusted), Uniqueness',
  },
  {
    term: 'Accuracy (Adjusted)',
    definition:
      'The fraction of an agent\'s findings that survived cross-review, with a penalty applied for hallucinations. Category Competency on the agent page shows the raw per-category ratio without the penalty; the Metrics section shows the penalized aggregate used for dispatch decisions.',
    seeAlso: 'Hallucination, Dispatch Weight',
  },
  {
    term: 'Uniqueness',
    definition:
      'How often this agent surfaces findings that no other agent in the same round found. High uniqueness with low accuracy is a useful combination: always include such agents in a consensus round, but never send them solo.',
    seeAlso: 'Accuracy (Adjusted), Consensus Round',
  },
  {
    term: 'Reliability',
    definition:
      'Task completion rate — the fraction of dispatched tasks that finished without a pipeline error or timeout. Distinct from accuracy, which measures finding correctness.',
    seeAlso: 'Accuracy (Adjusted)',
  },
  {
    term: 'Impact',
    definition:
      'A severity-weighted score for an agent\'s findings. Critical and high findings contribute more than medium or low ones. Impact reflects not just how many findings an agent produces, but how serious those findings tend to be.',
    seeAlso: 'Finding',
  },
  {
    term: 'Benched / Struggling / Kept for coverage',
    definition:
      'Circuit-breaker states that limit dispatch when an agent underperforms. Benched = fully excluded from dispatch (chronic = sustained low accuracy; burst = recent failure streak). Struggling = consecutive failures tripped the breaker; agent is deprioritized until it recovers. Kept for coverage = the agent would be benched, but it is the only agent with a required skill category, so it stays in the pool.',
    seeAlso: 'Dispatch Weight, Skill',
  },
  {
    term: 'Skill',
    definition:
      'A markdown file injected into an agent\'s prompt for a specific task category (e.g. input_validation, trust_boundaries). Skills are generated from an agent\'s actual failure history and override generic defaults. A skill graduates from pending to passed or failed after 120 post-bind signals.',
    seeAlso: 'bound_at',
  },
  {
    term: 'bound_at',
    definition:
      'The timestamp when a skill was attached to an agent. This anchors the effectiveness window: only signals recorded after bound_at count toward the skill\'s graduation verdict.',
    seeAlso: 'Skill',
  },
  {
    term: 'Invalid Output Types',
    definition:
      'Agent finding tags with a type= attribute outside the allowed set (finding, suggestion, insight). The pipeline silently rejects these — they never reach the consensus round or the dashboard. The count is tracked so skill development can address systematic format drift.',
    seeAlso: 'Finding',
  },
  {
    term: 'Process Violation',
    definition:
      'A guardrail breach detected outside normal code review. Examples: an agent pushed a commit directly to master bypassing the PR process, or an agent wrote to a file outside its declared scope. Process violations are logged separately from code findings.',
  },
];

export function GlossaryModal({ open, onClose }: GlossaryModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // Focus close button when modal opens
    const frame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="relative flex max-h-[calc(100vh-48px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="glossary-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-5 py-3.5">
          <h2
            id="glossary-title"
            className="font-mono text-sm font-semibold text-foreground"
          >
            Gossipcat Glossary
          </h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close glossary"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border/40 bg-card font-mono text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            &times;
          </button>
        </div>

        {/* Scrollable term list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <dl className="space-y-5">
            {TERMS.map(({ term, definition, seeAlso }) => (
              <div key={term} className="rounded-md border border-border/40 bg-background/40 px-4 py-3">
                <dt className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-amber-400">
                  {term}
                </dt>
                <dd className="mt-1.5 font-mono text-xs leading-relaxed text-foreground/80">
                  {definition}
                </dd>
                {seeAlso && (
                  <dd className="mt-1.5 font-mono text-[10px] text-muted-foreground/60">
                    See also: {seeAlso}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border/60 px-5 py-3">
          <a
            href="https://github.com/gossipcat-ai/gossipcat-ai/blob/master/docs/HANDBOOK.md"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-amber-400 transition hover:text-amber-300 hover:underline"
          >
            Read the full HANDBOOK &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
