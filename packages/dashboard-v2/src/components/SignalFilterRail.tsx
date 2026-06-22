import type { ChangeEvent } from 'react';

export interface SignalFilters {
  agents: string[];
  counterpart?: string;
  signals: string[];
  category?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  since?: string;
  until?: string;
  consensusId?: string;
  findingId?: string;
  source?: 'manual' | 'impl' | 'meta' | 'auto-provisional';
}

interface Props {
  filters: SignalFilters;
  onChange: (patch: Partial<SignalFilters>) => void;
  agents: string[];
  signalTypes: string[];
}

const SEVERITIES: Array<SignalFilters['severity']> = ['critical', 'high', 'medium', 'low'];
const SOURCES: Array<SignalFilters['source']> = ['manual', 'impl', 'meta', 'auto-provisional'];

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

const LABEL_CLS = 'mb-1 block h-section';
const LABEL_STYLE = {} as const;
const INPUT_CLS = 'w-full rounded border border-border px-2 py-1 font-mono text-[10px] focus:border-primary focus:outline-none';
const INPUT_STYLE = { background: 'var(--surface)', color: 'var(--text)' } as const;

export function SignalFilterRail({ filters, onChange, agents, signalTypes }: Props) {
  const set = <K extends keyof SignalFilters>(key: K) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    onChange({ [key]: v === '' ? undefined : (v as SignalFilters[K]) } as Partial<SignalFilters>);
  };

  return (
    <aside className="space-y-3 rounded-md border border-border/60 p-3" style={{ background: 'color-mix(in oklch, var(--surface-elev) 70%, transparent)' }}>
      <div className="flex items-center justify-between">
        <h2 className="h-section">Filters</h2>
        <button
          type="button"
          className="font-mono text-[9px]"
          style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}
          onClick={() =>
            onChange({
              agents: [],
              counterpart: undefined,
              signals: [],
              category: undefined,
              severity: undefined,
              since: undefined,
              until: undefined,
              consensusId: undefined,
              findingId: undefined,
              source: undefined,
            })
          }
        >
          clear
        </button>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Agents ({filters.agents.length} selected)</label>
        <div className="max-h-32 overflow-y-auto rounded border border-border/60 p-1" style={{ background: 'var(--surface)' }}>
          {agents.length === 0 && (
            <div className="px-1 py-0.5 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>no agents</div>
          )}
          {agents.map((a) => (
            <label key={a} className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 font-mono text-[10px] hover:bg-accent/20" style={{ color: 'var(--text)' }}>
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={filters.agents.includes(a)}
                onChange={() => onChange({ agents: toggleIn(filters.agents, a) })}
              />
              <span>{a}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Counterpart</label>
        <select className={INPUT_CLS} style={INPUT_STYLE} value={filters.counterpart ?? ''} onChange={set('counterpart')}>
          <option value="">any</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Signal types ({filters.signals.length})</label>
        <div className="max-h-32 overflow-y-auto rounded border border-border/60 p-1" style={{ background: 'var(--surface)' }}>
          {signalTypes.length === 0 && (
            <div className="px-1 py-0.5 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>no signals</div>
          )}
          {signalTypes.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 font-mono text-[10px] hover:bg-accent/20" style={{ color: 'var(--text)' }}>
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={filters.signals.includes(s)}
                onChange={() => onChange({ signals: toggleIn(filters.signals, s) })}
              />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Severity</label>
        <select className={INPUT_CLS} style={INPUT_STYLE} value={filters.severity ?? ''} onChange={set('severity')}>
          <option value="">any</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE} data-tooltip="manual = operator-recorded · impl = implementer pipeline · meta = orchestrator self-telemetry · auto-provisional = unvalidated">Source</label>
        <select className={INPUT_CLS} style={INPUT_STYLE} value={filters.source ?? ''} onChange={set('source')}>
          <option value="">any</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Category</label>
        <input
          type="text"
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={filters.category ?? ''}
          onChange={set('category')}
          placeholder="e.g. trust_boundaries"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL_CLS} style={LABEL_STYLE}>Since</label>
          <input
            type="datetime-local"
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={filters.since ? filters.since.slice(0, 16) : ''}
            onChange={(e) => onChange({ since: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          />
        </div>
        <div>
          <label className={LABEL_CLS} style={LABEL_STYLE}>Until</label>
          <input
            type="datetime-local"
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={filters.until ? filters.until.slice(0, 16) : ''}
            onChange={(e) => onChange({ until: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          />
        </div>
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Consensus ID (prefix)</label>
        <input type="text" className={INPUT_CLS} style={INPUT_STYLE} value={filters.consensusId ?? ''} onChange={set('consensusId')} placeholder="e.g. d07eac46" />
      </div>

      <div>
        <label className={LABEL_CLS} style={LABEL_STYLE}>Finding ID (prefix)</label>
        <input type="text" className={INPUT_CLS} style={INPUT_STYLE} value={filters.findingId ?? ''} onChange={set('findingId')} placeholder="e.g. d07eac46-5f464e89:sonnet" />
      </div>
    </aside>
  );
}
