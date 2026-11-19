import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  const store = new Map<string, string>();
  const redis = {
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
  };
  const controller = new AppController(new AppService(), redis as never);

  it('returns "Hello World!" from the root', () => {
    expect(controller.getHello()).toBe('Hello World!');
  });

  it('round-trips the keepalive key through Redis', async () => {
    await expect(controller.pingRedis()).resolves.toEqual({
      status: 'ok',
      redis: 'active',
    });
  });
});
