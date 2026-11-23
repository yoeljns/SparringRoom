import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tr from '@/i18n/tr.json';
import { feedback } from '@/lib/floor/feedback';
import { ScanFlow } from './ScanFlow';

vi.mock('@/lib/floor/feedback', () => ({ feedback: vi.fn(), unlockAudio: vi.fn() }));

function scan(value: string) {
  const input = screen.getByTestId('scan-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

const stepStates = () => Array.from(screen.getByTestId('scan-flow').querySelectorAll('li')).map((li) => li.getAttribute('data-state'));

describe('<ScanFlow>', () => {
  beforeEach(() => {
    vi.mocked(feedback).mockClear();
  });

  it('shows which scan is expected and completes after three good scans', async () => {
    const onComplete = vi.fn();
    render(<ScanFlow context="transfer" onComplete={onComplete} />);
    expect(stepStates()).toEqual(['current', 'pending', 'pending']);
    expect(screen.getByTestId('scan-input').getAttribute('placeholder')).toContain(tr.flow.source);

    scan('TZ-B03-L12');
    await waitFor(() => expect(stepStates()).toEqual(['done', 'current', 'pending']));
    scan('086912340000010011');
    await waitFor(() => expect(stepStates()).toEqual(['done', 'done', 'current']));
    scan('TZ-STG-01');
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    const values = onComplete.mock.calls[0][0];
    expect(values.source.scan).toMatchObject({ kind: 'location', code: 'TZ-B03-L12' });
    expect(values.pallet.scan).toMatchObject({ kind: 'pallet_serial', serial: '086912340000010011' });
    expect(values.destination.scan).toMatchObject({ kind: 'location', code: 'TZ-STG-01' });
    expect(vi.mocked(feedback).mock.calls.map((c) => c[0])).toEqual(['accepted', 'accepted', 'accepted']);
    expect(screen.getByRole('status').textContent).toContain(tr.flow.done);
  });

  it('refuses a scan of the wrong class with the refused tone and a red banner, and logs it', async () => {
    const logScan = vi.fn();
    render(<ScanFlow context="transfer" onComplete={() => {}} logScan={logScan} />);
    scan('086912340000010011'); // a pallet where the source lane is expected
    const banner = await screen.findByTestId('refusal-banner');
    expect(banner.textContent).toContain(tr.flow.source);
    expect(banner.textContent).toContain(tr.scan.kind.pallet_serial);
    expect(banner.className).toContain('bg-brand');
    expect(feedback).toHaveBeenCalledWith('refused');
    expect(stepStates()).toEqual(['current', 'pending', 'pending']);
    expect(logScan).toHaveBeenCalledWith(expect.objectContaining({ raw: '086912340000010011', context: 'transfer', reason: 'wrong_kind', method: 'scan' }));

    scan('TZ-B03-L12');
    await waitFor(() => expect(screen.queryByTestId('refusal-banner')).toBeNull());
    expect(stepStates()).toEqual(['done', 'current', 'pending']);
  });

  it('refuses and logs an unrecognised scan', async () => {
    const logScan = vi.fn();
    render(<ScanFlow context="pick" onComplete={() => {}} logScan={logScan} />);
    scan('???');
    expect((await screen.findByTestId('refusal-banner')).textContent).toContain(tr.scan.refused.unknown);
    expect(feedback).toHaveBeenCalledWith('refused');
    expect(logScan).toHaveBeenCalledWith(expect.objectContaining({ raw: '???', kind: 'unknown', reason: 'unknown', context: 'pick' }));
  });

  it('applies the business check and shows the Turkish message for its code', async () => {
    const validate = vi.fn(async (step: { key: string }) => (step.key === 'source' ? ({ ok: false, code: 'LANE_MIXED' } as const) : ({ ok: true } as const)));
    render(<ScanFlow context="putaway" onComplete={() => {}} validate={validate} />);
    scan('TZ-B03-L12');
    expect((await screen.findByTestId('refusal-banner')).textContent).toContain(tr.errors.LANE_MIXED);
    expect(stepStates()).toEqual(['current', 'pending', 'pending']);
  });

  it('restarts from the first step', async () => {
    render(<ScanFlow context="transfer" onComplete={() => {}} />);
    scan('TZ-B03-L12');
    await waitFor(() => expect(stepStates()).toEqual(['done', 'current', 'pending']));
    fireEvent.click(screen.getByText(tr.flow.restart));
    expect(stepStates()).toEqual(['current', 'pending', 'pending']);
  });
});
