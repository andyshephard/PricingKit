import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../concurrency';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 4, 3, 2, 1, 0], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n * 2;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([10, 8, 6, 4, 2, 0]);
  });

  it('stops starting work after the first failure and rethrows it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 1) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
