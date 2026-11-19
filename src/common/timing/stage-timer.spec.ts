import { performance } from 'node:perf_hooks';
import { StageTimer } from './stage-timer';

describe('StageTimer', () => {
  let now: number;

  beforeEach(() => {
    now = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('times a stage and reports the total since the request started', async () => {
    const timer = new StageTimer(900);

    await timer.time('chainRead', () => {
      now += 42.1234;
      return Promise.resolve();
    });

    expect(timer.toRecord()).toEqual({
      stages: { chainRead: 42.123 },
      totalMs: 142.123,
    });
  });

  it('records a stage even when it throws', async () => {
    const timer = new StageTimer();

    await expect(
      timer.time('computeCid', () => {
        now += 5;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');

    expect(timer.toRecord().stages).toEqual({ computeCid: 5 });
  });

  it('accumulates a repeated stage', async () => {
    const timer = new StageTimer();
    for (const ms of [3, 4]) {
      await timer.time('redis', () => {
        now += ms;
        return Promise.resolve();
      });
    }

    expect(timer.toRecord().stages).toEqual({ redis: 7 });
  });

  it('measures from a given start and carries extra fields', () => {
    const timer = new StageTimer(950);
    timer.set('cid', 'bafy');

    timer.since('guards', timer.start);

    expect(timer.toRecord()).toEqual({
      cid: 'bafy',
      stages: { guards: 50 },
      totalMs: 50,
    });
  });
});
