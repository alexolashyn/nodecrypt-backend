import { randomBytes } from 'node:crypto';
import type * as Harness from './e2e/harness';
import type { TestApp } from './e2e/harness';

async function boot(env: Record<string, string>) {
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  let harness!: typeof Harness;
  let t: TestApp;
  try {
    jest.isolateModules(() => {
      harness = jest.requireActual<typeof Harness>('./e2e/harness');
    });
    t = await harness.createTestApp({ appProviders: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await t.redis.flushdb();
  return { t, h: harness };
}

async function jsonLines(run: () => Promise<unknown>) {
  const lines: Record<string, unknown>[] = [];
  const write = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      const text = String(chunk);
      if (text.startsWith('{'))
        lines.push(JSON.parse(text) as Record<string, unknown>);
      return true;
    });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return lines;
}

const newFileId = () => `0x${randomBytes(32).toString('hex')}`;

interface FileStatus {
  cid: string;
  pinned: boolean;
  quorum: number;
  providers: Record<
    string,
    { status: string; error?: string; attempts?: number }
  >;
}

describe('Test mode (e2e)', () => {
  describe('PINNING_MODE=stub with timing logs', () => {
    let t: TestApp;
    let h: typeof Harness;

    beforeAll(async () => {
      ({ t, h } = await boot({
        PINNING_MODE: 'stub',
        PINNING_STUB_DELAY_MS: '50',
        UPLOAD_TIMING_LOG: '1',
        REDIS_TIMING_LOG: '1',
      }));
    });
    afterAll(() => t.close());

    it('pins on all three stub providers and logs every upload stage', async () => {
      const session = await h.signIn(t);
      const fileId = newFileId();
      const content = randomBytes(2048);
      t.chain.register(session.wallet.address, fileId, content);

      let res!: Awaited<ReturnType<ReturnType<TestApp['http']>['post']>>;
      const lines = await jsonLines(async () => {
        res = await t
          .http()
          .post(`/files/${fileId}`)
          .set('Authorization', `Bearer ${session.accessToken}`)
          .set('Content-Type', 'application/octet-stream')
          .send(content)
          .expect(201);
      });

      expect(h.envelope<FileStatus>(res).data).toMatchObject({
        cid: h.cidOf(content),
        pinned: true,
        providers: {
          pinata: { status: 'pinned' },
          filebase: { status: 'pinned' },
          octopin: { status: 'queued' },
        },
      });

      const timing = lines.find((l) => l.type === 'upload_timing')!;
      expect(timing).toMatchObject({
        requestId: res.headers['x-request-id'],
        fileId,
        status: 201,
        cid: h.cidOf(content),
        sizeBytes: content.length,
        path: 'upload',
      });
      const stages = timing.stages as Record<string, number>;
      expect(Object.keys(stages).sort()).toEqual(
        [
          'chainRead',
          'computeCid',
          'fileLock',
          'finalize',
          'gate',
          'guards',
          'pin.filebase',
          'pin.octopin',
          'pin.pinata',
          'quorum',
          'receiveBody',
        ].sort(),
      );
      expect(stages['pin.pinata']).toBeGreaterThanOrEqual(39);
      expect(stages.quorum).toBeGreaterThanOrEqual(stages['pin.pinata']);
      expect(timing.totalMs).toBeGreaterThanOrEqual(stages.quorum);
    });

    it('logs a failed upload with its status', async () => {
      const session = await h.signIn(t);
      const lines = await jsonLines(() =>
        t
          .http()
          .post(`/files/${newFileId()}`)
          .set('Authorization', `Bearer ${session.accessToken}`)
          .set('Content-Type', 'application/octet-stream')
          .send(randomBytes(16))
          .expect(404),
      );

      expect(lines.find((l) => l.type === 'upload_timing')).toMatchObject({
        status: 404,
        stages: { chainRead: expect.any(Number) as number },
      });
    });

    it('logs Redis timings by key namespace, never the key itself', async () => {
      let nonce = '';
      const lines = await jsonLines(async () => {
        const res = await t.http().get('/auth/nonce').expect(200);
        nonce = h.envelope<{ nonce: string }>(res).data.nonce;
      });

      const redis = lines.filter((l) => l.type === 'redis_timing');
      expect(redis).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: 'eval', keyPrefix: 'nc:throttle' }),
          expect.objectContaining({
            op: 'setex',
            keyPrefix: 'nonce',
            ok: true,
          }),
        ]),
      );
      expect(JSON.stringify(redis)).not.toContain(nonce);
    });

    it('serves /health with a request id, outside the rate limit', async () => {
      for (let i = 0; i < 7; i++) {
        const res = await t.http().get('/health').expect(200);
        expect(h.envelope(res).data).toEqual({ status: 'ok', redis: 'up' });
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      }
    });
  });

  describe('provider faults', () => {
    const uploadOnce = async (t: TestApp, h: typeof Harness) => {
      const session = await h.signIn(t);
      const fileId = newFileId();
      const content = randomBytes(512);
      t.chain.register(session.wallet.address, fileId, content);
      const res = await t
        .http()
        .post(`/files/${fileId}`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .set('Content-Type', 'application/octet-stream')
        .send(content);
      return { res, session, fileId, content };
    };

    const pollStatus = async (
      t: TestApp,
      h: typeof Harness,
      session: Harness.Session,
      fileId: string,
      done: (s: FileStatus) => boolean,
    ) => {
      for (let i = 0; i < 50; i++) {
        const res = await t
          .http()
          .get(`/files/${fileId}`)
          .set('Authorization', `Bearer ${session.accessToken}`)
          .expect(200);
        const status = h.envelope<FileStatus>(res).data;
        if (done(status)) return status;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('Status never reached the expected state');
    };

    const withFaults = async (
      faults: string,
      run: (t: TestApp, h: typeof Harness) => Promise<void>,
      env: Record<string, string> = {},
    ) => {
      const { t, h } = await boot({
        PINNING_MODE: 'stub',
        PINNING_STUB_DELAY_MS: '0',
        PIN_CONFIRM_POLL_MS: '10',
        PIN_RETRY_INTERVAL_MS: '50',
        PIN_RETRY_MAX_ATTEMPTS: '3',
        TEST_FAULTS: faults,
        ...env,
      });
      try {
        await run(t, h);
      } finally {
        await t.close();
      }
    };

    const down = {
      status: 'failed',
      error: expect.stringContaining('down') as string,
    };

    it('finishes octopin in the background once 2 of 3 are met', () =>
      withFaults('', async (t, h) => {
        const { res, session, fileId } = await uploadOnce(t, h);

        expect(res.status).toBe(201);
        expect(h.envelope<FileStatus>(res).data).toMatchObject({
          pinned: true,
          quorum: 2,
          providers: {
            pinata: { status: 'pinned' },
            filebase: { status: 'pinned' },
            octopin: { status: 'queued', attempts: 1 },
          },
        });
        const settled = await pollStatus(
          t,
          h,
          session,
          fileId,
          (s) => s.providers.octopin.status === 'pinned',
        );
        expect(settled.providers.octopin).toMatchObject({ attempts: 1 });
      }));

    describe('one of three providers down', () => {
      it.each(['pinata', 'filebase'])(
        'stores with %s down by confirming octopin in the request',
        (name) =>
          withFaults(`fail_${name}`, async (t, h) => {
            const { res } = await uploadOnce(t, h);

            expect(res.status).toBe(201);
            const { providers } = h.envelope<FileStatus>(res).data;
            expect(providers[name]).toMatchObject(down);
            expect(providers.octopin).toMatchObject({ status: 'pinned' });
          }),
      );

      it('stores with octopin down and keeps retrying it in the background', () =>
        withFaults('fail_octopin', async (t, h) => {
          const { res, session, fileId } = await uploadOnce(t, h);

          expect(res.status).toBe(201);
          expect(h.envelope<FileStatus>(res).data).toMatchObject({
            pinned: true,
            providers: {
              pinata: { status: 'pinned' },
              filebase: { status: 'pinned' },
              octopin: { ...down, attempts: 1 },
            },
          });
          const exhausted = await pollStatus(
            t,
            h,
            session,
            fileId,
            (s) => s.providers.octopin.attempts === 3,
          );
          expect(exhausted.pinned).toBe(true);
          expect(exhausted.providers.octopin.error).toMatch(/^Gave up after 3/);
        }));
    });

    describe('two of three providers down', () => {
      it.each([
        ['fail_pinata,fail_filebase'],
        ['fail_pinata,fail_octopin'],
        ['fail_filebase,fail_octopin'],
      ])('refuses with 502 and keeps nothing (%s)', (faults) =>
        withFaults(faults, async (t, h) => {
          const { res, session, fileId } = await uploadOnce(t, h);

          expect(res.status).toBe(502);
          await t
            .http()
            .get(`/files/${fileId}`)
            .set('Authorization', `Bearer ${session.accessToken}`)
            .expect(404);
          expect(await t.redis.zcard('nc:pin-retry')).toBe(0);
        }),
      );

      it('stores on the one survivor when the quorum is 1', () =>
        withFaults(
          'fail_pinata,fail_octopin',
          async (t, h) => {
            const { res } = await uploadOnce(t, h);

            expect(res.status).toBe(201);
            expect(h.envelope<FileStatus>(res).data).toMatchObject({
              pinned: true,
              providers: {
                pinata: down,
                filebase: { status: 'pinned' },
                octopin: down,
              },
            });
          },
          { PIN_QUORUM: '1' },
        ));

      it('cannot use octopin alone, even with a quorum of 1', () =>
        withFaults(
          'fail_pinata,fail_filebase',
          async (t, h) => {
            const { res } = await uploadOnce(t, h);

            expect(res.status).toBe(502);
          },
          { PIN_QUORUM: '1' },
        ));
    });

    it('refuses with 502 when all three are down', () =>
      withFaults('fail_pinata,fail_filebase,fail_octopin', async (t, h) => {
        const { res } = await uploadOnce(t, h);

        expect(res.status).toBe(502);
      }));

    it('releases the pin on all three after an on-chain removal', () =>
      withFaults('', async (t, h) => {
        const { res, session, fileId } = await uploadOnce(t, h);
        expect(res.status).toBe(201);
        const { cid } = h.envelope<FileStatus>(res).data;
        t.chain.remove(session.wallet.address, fileId);

        await t
          .http()
          .delete(`/files/${fileId}`)
          .set('Authorization', `Bearer ${session.accessToken}`)
          .expect(200);

        expect(await t.redis.exists(`nc:cid:${cid}:pins`)).toBe(0);
        expect(await t.redis.zcard('nc:pin-retry')).toBe(0);
      }));

    it('returns a CID that differs from the on-chain one under wrong_cid', async () => {
      const { t, h } = await boot({
        PINNING_MODE: 'stub',
        PINNING_STUB_DELAY_MS: '0',
        TEST_FAULTS: 'wrong_cid',
      });
      try {
        const { res, content } = await uploadOnce(t, h);

        expect(res.status).toBe(201);
        const { cid } = h.envelope<FileStatus>(res).data;
        expect(cid).not.toBe(h.cidOf(content));
        expect(cid).toHaveLength(h.cidOf(content).length);
      } finally {
        await t.close();
      }
    });
  });
});
