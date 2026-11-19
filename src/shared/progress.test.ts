import { afterEach, describe, expect, it, vi } from 'vitest';
import { objectiveLabel, setProgress, withProgress } from './progress.js';

afterEach(() => { setProgress(undefined); vi.useRealTimers(); });

describe('Kane progress lines (AUD-10)', () => {
  it('prints a start line and a heartbeat every 30 s while the run is going, then stops', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    setProgress((l) => lines.push(l));
    let finish!: (v: string) => void;
    const run = withProgress('alice: create a note', () => new Promise<string>((r) => { finish = r; }));
    expect(lines).toEqual(['  ▸ alice: create a note: Kane run started']);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(lines.slice(1)).toEqual(['    … alice: create a note: still running (30s)', '    … alice: create a note: still running (1m 00s)']);
    finish('done');
    expect(await run).toBe('done');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toHaveLength(3); // no heartbeat after the run ended
  });

  it('is silent without a sink (hooks, the engine and tests by default)', async () => {
    const spy = vi.spyOn(console, 'error');
    expect(await withProgress('x', async () => 42)).toBe(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('labels are one short line', () => {
    const l = objectiveLabel('bob', 'Go to http://127.0.0.1:3077/notes/1001\n and wait for the page '.repeat(4), 30);
    expect(l).toBe('bob: Go to http://127.0.0.1:3077/n…');
    expect(l).not.toContain('\n');
  });
});
