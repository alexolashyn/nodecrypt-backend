import { ConfigService } from '@nestjs/config';
import { PinRetryWorker } from './pin-retry.worker';
import { PinStateRepository, RetryEntry } from './pin-state.repository';
import { PinningService } from './pinning.service';

const due: RetryEntry[] = [
  { provider: 'octopin', cid: 'bafy1' },
  { provider: 'octopin', cid: 'bafy2' },
];

function setup() {
  const pinning = { followUp: jest.fn().mockResolvedValue(undefined) };
  const state = { dueRetries: jest.fn().mockResolvedValue(due) };
  const worker = new PinRetryWorker(
    pinning as unknown as PinningService,
    state as unknown as PinStateRepository,
    new ConfigService({ PIN_RETRY_INTERVAL_MS: 50 }),
  );
  return { worker, pinning, state };
}

describe('PinRetryWorker', () => {
  afterEach(() => jest.useRealTimers());

  it('follows up every due entry', async () => {
    const { worker, pinning } = setup();

    expect(await worker.tick()).toBe(2);
    expect(pinning.followUp.mock.calls).toEqual(due.map((e) => [e]));
  });

  it('keeps going when one follow-up throws', async () => {
    const { worker, pinning } = setup();
    pinning.followUp.mockRejectedValueOnce(new Error('redis down'));

    await worker.tick();

    expect(pinning.followUp).toHaveBeenCalledTimes(2);
  });

  it('survives an unreadable queue', async () => {
    const { worker, state } = setup();
    state.dueRetries.mockRejectedValue(new Error('redis down'));

    await expect(worker.tick()).resolves.toBe(0);
  });

  it('never runs two passes at once', async () => {
    const { worker, state } = setup();

    await Promise.all([worker.tick(), worker.tick()]);

    expect(state.dueRetries).toHaveBeenCalledTimes(1);
  });

  it('ticks on its interval after bootstrap and stops on shutdown', async () => {
    jest.useFakeTimers();
    const { worker, state } = setup();

    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(120);
    expect(state.dueRetries).toHaveBeenCalledTimes(2);

    await worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(200);
    expect(state.dueRetries).toHaveBeenCalledTimes(2);
  });
});
