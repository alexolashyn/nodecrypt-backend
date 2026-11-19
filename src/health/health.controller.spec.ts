import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = (ping: () => Promise<boolean>) =>
    new HealthController({ ping } as never);

  it('reports ok while Redis answers', async () => {
    await expect(
      controller(() => Promise.resolve(true)).check(),
    ).resolves.toEqual({ status: 'ok', redis: 'up' });
  });

  it('reports 503 when the ping fails', async () => {
    await expect(
      controller(() => Promise.reject(new Error('down'))).check(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports 503 instead of hanging while Redis is unreachable', async () => {
    jest.useFakeTimers();
    try {
      const result = controller(() => new Promise<boolean>(() => {})).check();
      jest.advanceTimersByTime(1000);

      await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      jest.useRealTimers();
    }
  });
});
