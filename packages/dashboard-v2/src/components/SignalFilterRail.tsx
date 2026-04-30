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

const LABEL_CLS = 'mb-1 block font-mono text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/70';
const INPUT_CLS = 'w-full rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none';

export function SignalFilterRail({ filters, onChange, agents, signalTypes }: Props) {
  const set = <K extends keyof SignalFilters>(key: K) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    onChange({ [key]: v === '' ? undefined : (v as SignalFilters[K]) } as Partial<SignalFilters>);
  };

  return (
    <aside className="space-y-3 rounded-md border border-border/60 bg-card/70 p-3">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">Filters</h2>
        <button
          type="button"
          className="font-mono text-[9px] text-muted-foreground/70 hover:text-foreground"
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
        <label className={LABEL_CLS}>Agents ({filters.agents.length} selected)</label>
        <div className="max-h-32 overflow-y-auto rounded border border-border/60 bg-background p-1">
          {agents.length === 0 && (
            <div className="px-1 py-0.5 font-mono text-[10px] text-muted-foreground/50">no agents</div>
          )}
          {agents.map((a) => (
            <label key={a} className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 font-mono text-[10px] text-foreground hover:bg-muted/40">
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
        <label className={LABEL_CLS}>Counterpart</label>
        <select className={INPUT_CLS} value={filters.counterpart ?? ''} onChange={set('counterpart')}>
          <option value="">any</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLS}>Signal types ({filters.signals.length})</label>
        <div className="max-h-32 overflow-y-auto rounded border border-border/60 bg-background p-1">
          {signalTypes.length === 0 && (
            <div className="px-1 py-0.5 font-mono text-[10px] text-muted-foreground/50">no signals</div>
          )}
          {signalTypes.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1.5 px-1 py-0.5 font-mono text-[10px] text-foreground hover:bg-muted/40">
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
        <label className={LABEL_CLS}>Severity</label>
        <select className={INPUT_CLS} value={filters.severity ?? ''} onChange={set('severity')}>
          <option value="">any</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLS} data-tooltip="manual = operator-recorded · impl = implementer pipeline · meta = orchestrator self-telemetry · auto-provisional = unvalidated">Source</label>
        <select className={INPUT_CLS} value={filters.source ?? ''} onChange={set('source')}>
          <option value="">any</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL_CLS}>Category</label>
        <input
          type="text"
          className={INPUT_CLS}
          value={filters.category ?? ''}
          onChange={set('category')}
          placeholder="e.g. trust_boundaries"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL_CLS}>Since</label>
          <input
            type="datetime-local"
            className={INPUT_CLS}
            value={filters.since ? filters.since.slice(0, 16) : ''}
            onChange={(e) => onChange({ since: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          />
        </div>
        <div>
          <label className={LABEL_CLS}>Until</label>
          <input
            type="datetime-local"
            className={INPUT_CLS}
            value={filters.until ? filters.until.slice(0, 16) : ''}
            onChange={(e) => onChange({ until: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          />
        </div>
      </div>

      <div>
        <label className={LABEL_CLS}>Consensus ID (prefix)</label>
        <input type="text" className={INPUT_CLS} value={filters.consensusId ?? ''} onChange={set('consensusId')} placeholder="e.g. d07eac46" />
      </div>

      <div>
        <label className={LABEL_CLS}>Finding ID (prefix)</label>
        <input type="text" className={INPUT_CLS} value={filters.findingId ?? ''} onChange={set('findingId')} placeholder="e.g. d07eac46-5f464e89:sonnet" />
      </div>
    </aside>
  );
}
