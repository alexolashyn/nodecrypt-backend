import { Wallet } from 'ethers';
import { SiweMessage } from 'siwe';
import {
  createTestApp,
  envelope,
  refreshCookie,
  signIn,
  TestApp,
} from './e2e/harness';

describe('Auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.redis.flushdb());

  const cookieValue = (cookie: string) => cookie.split(';')[0];

  it('logs in with a SIWE signature and sets a locked-down refresh cookie', async () => {
    const { accessToken, cookie } = await signIn(t);

    expect(accessToken.split('.')).toHaveLength(3);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const status = await t
      .http()
      .get(`/files/0x${'ab'.repeat(32)}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(status.status).toBe(404);
  });

  it('never returns the refresh token in the body', async () => {
    const wallet = Wallet.createRandom();
    const { nonce } = envelope<{ nonce: string }>(
      await t.http().get('/auth/nonce'),
    ).data;
    const message = new SiweMessage({
      domain: 'localhost',
      address: wallet.address,
      uri: 'http://localhost:5173',
      version: '1',
      chainId: 11155111,
      nonce,
    }).prepareMessage();

    const res = await t
      .http()
      .post('/auth/verify')
      .send({ message, signature: await wallet.signMessage(message) })
      .expect(201);

    expect(Object.keys(envelope(res).data).sort()).toEqual([
      'accessToken',
      'address',
    ]);
  });

  it('refuses to replay a signed login', async () => {
    const wallet = Wallet.createRandom();
    const { nonce } = envelope<{ nonce: string }>(
      await t.http().get('/auth/nonce'),
    ).data;
    const message = new SiweMessage({
      domain: 'localhost',
      address: wallet.address,
      uri: 'http://localhost:5173',
      version: '1',
      chainId: 11155111,
      nonce,
    }).prepareMessage();
    const body = { message, signature: await wallet.signMessage(message) };

    await t.http().post('/auth/verify').send(body).expect(201);
    const replay = await t.http().post('/auth/verify').send(body).expect(401);

    expect(envelope(replay).message).toBe(
      'Nonce is invalid, expired, or already used',
    );
  });

  it('rejects a verify body with unknown fields', async () => {
    await t
      .http()
      .post('/auth/verify')
      .send({ message: 'm', signature: 's', isAdmin: true })
      .expect(400);
  });

  it('rotates the refresh cookie and kills the old one', async () => {
    const { cookie } = await signIn(t);

    const refreshed = await t
      .http()
      .post('/auth/refresh')
      .set('Cookie', cookieValue(cookie))
      .expect(201);
    const next = refreshCookie(refreshed);
    expect(cookieValue(next)).not.toBe(cookieValue(cookie));

    await t
      .http()
      .post('/auth/refresh')
      .set('Cookie', cookieValue(cookie))
      .expect(401);
    await t
      .http()
      .post('/auth/refresh')
      .set('Cookie', cookieValue(next))
      .expect(201);
  });

  it('refuses a refresh without the cookie', async () => {
    await t.http().post('/auth/refresh').expect(401);
  });

  it('revokes the session on logout', async () => {
    const { cookie } = await signIn(t);

    const res = await t
      .http()
      .post('/auth/logout')
      .set('Cookie', cookieValue(cookie))
      .expect(201);
    expect(res.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^refreshToken=;/)]),
    );

    await t
      .http()
      .post('/auth/refresh')
      .set('Cookie', cookieValue(cookie))
      .expect(401);
  });

  it('rejects a forged access token', async () => {
    const { accessToken } = await signIn(t);
    const [header, payload] = accessToken.split('.');
    const forged = `${header}.${payload}.${'A'.repeat(43)}`;

    await t
      .http()
      .get(`/files/0x${'ab'.repeat(32)}`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });
});
