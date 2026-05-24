import { href } from '@/lib/router';
import { ConsensusFlow } from '@/components/ConsensusFlow';

interface ConsensusFlowPageProps {
  consensusId: string;
}

export function ConsensusFlowPage({ consensusId }: ConsensusFlowPageProps) {
  return (
    <>
      <div className="mb-6">
        <nav
          className="mb-2 flex items-center gap-2 font-mono text-[11px]"
          style={{ color: 'var(--ink-3)' }}
          aria-label="Breadcrumb"
        >
          <a
            href={href('/debates')}
            className="hover:underline"
            style={{ color: 'var(--ink-3)' }}
          >
            Consensus
          </a>
          <span aria-hidden="true">›</span>
          <span style={{ color: 'var(--ink)' }}>{consensusId}</span>
        </nav>
        <h1 className="h-section">Consensus flow</h1>
        <p
          className="mt-0.5 font-mono text-[10px]"
          style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}
        >
          Model families on the left, findings reviewed in the middle, verdicts on the right.
        </p>
      </div>

      <ConsensusFlow consensusId={consensusId} />
    </>
  );
}
