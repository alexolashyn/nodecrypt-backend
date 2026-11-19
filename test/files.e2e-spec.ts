import { randomBytes } from 'node:crypto';
import {
  cidOf,
  createTestApp,
  envelope,
  Session,
  signIn,
  TestApp,
} from './e2e/harness';

interface FileStatus {
  fileId: string;
  cid: string;
  pinned: boolean;
  providers: Record<string, { status: string }>;
}

const newFileId = () => `0x${randomBytes(32).toString('hex')}`;

describe('Files (e2e)', () => {
  let t: TestApp;
  let session: Session;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.redis.flushdb();
    for (const p of t.providers) {
      p.uploads.length = 0;
      p.unpinned.length = 0;
    }
    session = await signIn(t);
  });

  const owner = () => session.wallet.address;
  const auth = () => `Bearer ${session.accessToken}`;

  const upload = (fileId: string, content: Buffer) =>
    t
      .http()
      .post(`/files/${fileId}`)
      .set('Authorization', auth())
      .set('Content-Type', 'application/octet-stream')
      .send(content);

  it('verifies, pins on all three providers and reports the status', async () => {
    const fileId = newFileId();
    const content = randomBytes(4096);
    t.chain.register(owner(), fileId, content);

    const res = await upload(fileId, content).expect(201);

    const status = envelope<FileStatus>(res).data;
    expect(status).toMatchObject({
      fileId,
      cid: cidOf(content),
      pinned: true,
      providers: {
        pinata: { status: 'pinned' },
        filebase: { status: 'pinned' },
        octopin: { status: 'queued' },
      },
    });
    expect(JSON.stringify(status)).not.toContain('-ref');

    const polled = await t
      .http()
      .get(`/files/${fileId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(envelope<FileStatus>(polled).data).toEqual(status);
    expect(t.providers.map((p) => p.uploads)).toEqual([
      [cidOf(content)],
      [cidOf(content)],
      [cidOf(content)],
    ]);
  });

  it('accepts an upload whose fileId casing differs from the registration', async () => {
    const fileId = newFileId();
    const content = randomBytes(64);
    t.chain.register(owner(), fileId, content);

    await upload(fileId.toUpperCase().replace('0X', '0x'), content).expect(201);
  });

  it('refuses bytes that do not match the on-chain CID', async () => {
    const fileId = newFileId();
    t.chain.register(owner(), fileId, randomBytes(128));

    const res = await upload(fileId, randomBytes(128)).expect(400);

    expect(envelope(res).message).toMatch(/^Content hashes to/);
    expect(t.providers[0].uploads).toHaveLength(0);
  });

  it('refuses a body of a different size than registered', async () => {
    const fileId = newFileId();
    t.chain.register(owner(), fileId, randomBytes(128));

    await upload(fileId, randomBytes(256)).expect(413);
    await upload(fileId, randomBytes(64)).expect(400);
  });

  it('refuses a file that is not registered on-chain', async () => {
    await upload(newFileId(), randomBytes(16)).expect(404);
  });

  it('refuses a file registered by someone else', async () => {
    const fileId = newFileId();
    const content = randomBytes(32);
    t.chain.register('0x' + '9'.repeat(40), fileId, content);

    await upload(fileId, content).expect(404);
  });

  it('stores identical content once and shares the pin across records', async () => {
    const content = randomBytes(512);
    const [first, second] = [newFileId(), newFileId()];
    t.chain.register(owner(), first, content);
    t.chain.register(owner(), second, content);

    await upload(first, content).expect(201);
    await upload(second, content).expect(201);

    for (const p of t.providers) expect(p.uploads).toHaveLength(1);
  });

  describe('remove', () => {
    it('refuses while the record is still live on-chain', async () => {
      const fileId = newFileId();
      const content = randomBytes(32);
      t.chain.register(owner(), fileId, content);
      await upload(fileId, content).expect(201);

      await t
        .http()
        .delete(`/files/${fileId}`)
        .set('Authorization', auth())
        .expect(409);
    });

    it('unpins only once the last record referencing the content is removed', async () => {
      const content = randomBytes(256);
      const [first, second] = [newFileId(), newFileId()];
      for (const id of [first, second]) {
        t.chain.register(owner(), id, content);
        await upload(id, content).expect(201);
      }
      const remove = async (fileId: string) => {
        t.chain.remove(owner(), fileId);
        const res = await t
          .http()
          .delete(`/files/${fileId}`)
          .set('Authorization', auth())
          .expect(200);
        return envelope<{ released: boolean }>(res).data;
      };

      expect(await remove(first)).toEqual({ fileId: first, released: true });
      for (const p of t.providers) expect(p.unpinned).toHaveLength(0);

      await remove(second);
      expect(t.providers.map((p) => [p.name, p.unpinned])).toEqual([
        ['pinata', [cidOf(content)]],
        ['filebase', [cidOf(content)]],
        ['octopin', [cidOf(content)]],
      ]);

      await t
        .http()
        .get(`/files/${second}`)
        .set('Authorization', auth())
        .expect(404);
    });
  });
});
