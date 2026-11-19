import { createTestApp, envelope, signIn, TestApp } from './e2e/harness';

describe('App (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.redis.flushdb());

  it('wraps a public route in the success envelope', async () => {
    const res = await t.http().get('/').expect(200);

    expect(envelope(res)).toMatchObject({
      success: true,
      statusCode: 200,
      data: 'Hello World!',
    });
  });

  it('answers an unknown route with a 404 envelope', async () => {
    const res = await t.http().get('/no-such-route').expect(404);

    expect(envelope(res)).toMatchObject({ success: false, statusCode: 404 });
  });

  it('protects routes by default', async () => {
    const res = await t
      .http()
      .get(`/files/0x${'ab'.repeat(32)}`)
      .expect(401);

    expect(envelope(res).success).toBe(false);
  });

  it('runs global validation on route params', async () => {
    const { accessToken } = await signIn(t);

    const res = await t
      .http()
      .get('/files/0xnot-a-file-id')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);

    expect(envelope(res).message).toEqual([
      'fileId must be a 0x-prefixed bytes32 hex string',
    ]);
  });

  describe('throttle', () => {
    it('refuses with 429 and Retry-After past the limit', async () => {
      for (let i = 0; i < 5; i++) {
        const ok = await t.http().get('/auth/nonce').expect(200);
        expect(ok.headers['x-ratelimit-remaining']).toBe(String(4 - i));
      }

      const res = await t.http().get('/auth/nonce').expect(429);

      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(envelope(res).message).toBe('Too many requests; retry later');
    });

    it('keeps a separate budget per route', async () => {
      for (let i = 0; i < 6; i++) await t.http().get('/auth/nonce');

      await t.http().get('/').expect(200);
    });
  });
});
