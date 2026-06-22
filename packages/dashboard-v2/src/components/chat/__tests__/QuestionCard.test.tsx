import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuestionCard } from '../QuestionCard';
import type { PendingQuestion } from '@/lib/useBridge';

/**
 * QuestionCard — control type per multiSelect, Submit gating, payload shape.
 */

function single(): PendingQuestion {
  return {
    qid: 'qid-1',
    ts: '2026-06-16T10:00:00.000Z',
    questions: [
      { questionId: 'q0', header: 'Approach', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] },
    ],
  };
}

function multi(): PendingQuestion {
  return {
    qid: 'qid-2',
    ts: '2026-06-16T10:00:00.000Z',
    questions: [
      { questionId: 'q0', header: 'Tags', question: 'pick many', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
    ],
  };
}

function withOther(): PendingQuestion {
  return {
    qid: 'qid-3',
    ts: '2026-06-16T10:00:00.000Z',
    questions: [
      { questionId: 'q0', header: 'Free', question: 'pick or type', allowOther: true, options: [{ label: 'A' }] },
    ],
  };
}

describe('QuestionCard', () => {
  it('renders RADIOS for a single-select question', () => {
    render(<QuestionCard pending={single()} onSubmit={vi.fn(async () => true)} />);
    const inputs = screen.getAllByRole('radio');
    expect(inputs).toHaveLength(2);
  });

  it('renders CHECKBOXES for a multiSelect question', () => {
    render(<QuestionCard pending={multi()} onSubmit={vi.fn(async () => true)} />);
    const inputs = screen.getAllByRole('checkbox');
    expect(inputs).toHaveLength(2);
  });

  it('disables Submit until a selection is made, then posts the expected payload', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<QuestionCard pending={single()} onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: /submit answer/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getAllByRole('radio')[1]); // select 'B'
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q0', selected: ['B'] }])
    );
  });

  it('enables Submit via Other text alone and includes it in the payload', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<QuestionCard pending={withOther()} onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: /submit answer/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/other answer/i), { target: { value: 'custom thing' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q0', selected: [], other: 'custom thing' }])
    );
  });

  it('multi-select accumulates multiple labels', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<QuestionCard pending={multi()} onSubmit={onSubmit} />);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'q0', selected: ['x', 'y'] }])
    );
  });
});
