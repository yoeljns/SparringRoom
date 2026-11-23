import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GS } from '@dayson/domain';
import tr from '@/i18n/tr.json';
import { ScanInput } from './ScanInput';

/** DataWedge keystroke output: the characters, then Enter. */
function scan(value: string) {
  const input = screen.getByTestId('scan-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

describe('<ScanInput>', () => {
  it('classifies the scan on Enter, passes the raw string and clears the field', () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} />);
    const input = scan('TZ-B03-L12');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith({ kind: 'location', raw: 'TZ-B03-L12', code: 'TZ-B03-L12' }, { method: 'scan' });
    expect(input.value).toBe('');
    expect(screen.getByTestId('last-scan').textContent).toContain('TZ-B03-L12');
    expect(screen.getByTestId('last-scan').textContent).toContain(tr.scan.kind.location);
  });

  it('reports an unknown scan instead of dropping it', () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} />);
    scan('garbage');
    expect(onScan.mock.calls[0][0]).toMatchObject({ kind: 'unknown', raw: 'garbage' });
  });

  it('ignores an empty Enter', () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} />);
    scan('   ');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('is focused on mount, keeps the soft keyboard closed and takes the focus back after a blur and a tap', async () => {
    vi.useFakeTimers();
    try {
      render(
        <div>
          <ScanInput onScan={() => {}} />
          <button type="button">other</button>
        </div>,
      );
      const input = screen.getByTestId('scan-input') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('inputmode')).toBe('none');

      const other = screen.getByText('other');
      act(() => {
        other.focus();
        fireEvent.blur(input);
      });
      expect(document.activeElement).toBe(other);
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(document.activeElement).toBe(input);

      act(() => {
        other.focus();
        fireEvent.pointerUp(document.body);
        vi.advanceTimersByTime(10);
      });
      expect(document.activeElement).toBe(input);

      act(() => {
        input.blur();
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(10);
      });
      expect(document.activeElement).toBe(input);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not steal the focus from another input', () => {
    vi.useFakeTimers();
    try {
      render(
        <div>
          <ScanInput onScan={() => {}} />
          <input data-testid="qty" />
        </div>,
      );
      const qty = screen.getByTestId('qty');
      act(() => {
        qty.focus();
        vi.advanceTimersByTime(100);
      });
      expect(document.activeElement).toBe(qty);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns Ctrl+] into the GS1 separator', () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} />);
    const input = screen.getByTestId('scan-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: ']', ctrlKey: true });
    expect(input.value).toBe(GS);
  });

  it('drops scans while disabled', () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} disabled />);
    const input = scan('TZ-B03-L12');
    expect(onScan).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  describe('manual entry', () => {
    it('requires a reason code and marks the scan as manual', () => {
      const onScan = vi.fn();
      render(<ScanInput onScan={onScan} />);
      fireEvent.click(screen.getByText(tr.scan.manualOn));
      expect(screen.getByTestId('manual-panel')).toBeTruthy();
      const input = screen.getByTestId('scan-input') as HTMLInputElement;
      expect(input.getAttribute('inputmode')).toBe('text');

      // No reason yet: refused, text kept.
      fireEvent.change(input, { target: { value: 'tz-b03-l12' } });
      fireEvent.click(screen.getByText(tr.scan.submit));
      expect(onScan).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toBe(tr.scan.reasonRequired);
      expect(input.value).toBe('tz-b03-l12');

      fireEvent.click(screen.getByText(tr.scan.reasons.label_damaged));
      fireEvent.click(screen.getByText(tr.scan.submit));
      expect(onScan).toHaveBeenCalledWith(
        { kind: 'location', raw: 'tz-b03-l12', code: 'TZ-B03-L12' },
        { method: 'manual', reason_code: 'label_damaged' },
      );
      // Back to scanner mode after one manual entry.
      expect(screen.queryByTestId('manual-panel')).toBeNull();
      expect(screen.getByTestId('last-scan').textContent).toContain(tr.scan.method.manual);
    });

    it('can be hidden', () => {
      render(<ScanInput onScan={() => {}} allowManual={false} />);
      expect(screen.queryByText(tr.scan.manualOn)).toBeNull();
    });
  });
});
