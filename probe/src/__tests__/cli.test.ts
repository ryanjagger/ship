import { describe, expect, it, vi } from 'vitest';
import { maybeOpenReport } from '../cli.js';

describe('maybeOpenReport', () => {
  it('opens the HTML when interactive + stdout TTY', async () => {
    const fakeOpen = vi.fn().mockResolvedValue(undefined);
    await maybeOpenReport(true, '/tmp/report.html', true, fakeOpen);
    expect(fakeOpen).toHaveBeenCalledTimes(1);
    expect(fakeOpen).toHaveBeenCalledWith('/tmp/report.html');
  });

  it('does not open when the run was not interactive', async () => {
    const fakeOpen = vi.fn().mockResolvedValue(undefined);
    await maybeOpenReport(false, '/tmp/report.html', true, fakeOpen);
    expect(fakeOpen).not.toHaveBeenCalled();
  });

  it('does not open when stdout is not a TTY', async () => {
    const fakeOpen = vi.fn().mockResolvedValue(undefined);
    await maybeOpenReport(true, '/tmp/report.html', false, fakeOpen);
    expect(fakeOpen).not.toHaveBeenCalled();
  });

  it('does not open when both flags are false', async () => {
    const fakeOpen = vi.fn().mockResolvedValue(undefined);
    await maybeOpenReport(false, '/tmp/report.html', false, fakeOpen);
    expect(fakeOpen).not.toHaveBeenCalled();
  });

  it('logs a warning and returns normally when open() throws', async () => {
    const fakeOpen = vi.fn().mockRejectedValue(new Error('no DISPLAY'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(maybeOpenReport(true, '/tmp/report.html', true, fakeOpen)).resolves.toBeUndefined();

    expect(fakeOpen).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('/tmp/report.html');
    expect(message).toContain('manually');
    expect(message).toContain('no DISPLAY');

    warnSpy.mockRestore();
  });
});
