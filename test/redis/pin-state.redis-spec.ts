import {
  PinStateRepository,
  ProviderPin,
} from 'src/pinning/pin-state.repository';
import { connectRedis, TestRedis } from './helpers';

const CID = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am';
const pinned = (ref: string): ProviderPin => ({
  status: 'pinned',
  ref,
  updatedAt: '2026-11-19T10:00:00.000Z',
});

describe('PinStateRepository against real Redis', () => {
  let r: TestRedis;
  let state: PinStateRepository;

  beforeAll(() => {
    r = connectRedis();
    state = new PinStateRepository(r.service);
  });
  afterAll(() => r.close());
  beforeEach(() => r.raw.flushdb());

  describe('file records', () => {
    it('round-trips and deletes the CID pinned for a record', async () => {
      expect(await state.getFileCid('0xowner', '0xfile')).toBeNull();

      await state.setFileCid('0xowner', '0xfile', CID);
      expect(await state.getFileCid('0xowner', '0xfile')).toBe(CID);

      await state.deleteFile('0xowner', '0xfile');
      expect(await state.getFileCid('0xowner', '0xfile')).toBeNull();
    });
  });

  describe('references', () => {
    it('counts a retried reference once', async () => {
      await state.addRef(CID, 'a:1');
      await state.addRef(CID, 'a:1');

      expect(await state.refCount(CID)).toBe(1);
    });

    it('counts distinct records and drops one on release', async () => {
      await state.addRef(CID, 'a:1');
      await state.addRef(CID, 'b:2');
      expect(await state.refCount(CID)).toBe(2);

      await state.removeRef(CID, 'a:1');
      expect(await state.refCount(CID)).toBe(1);
    });

    it('reports zero for a CID nobody references', async () => {
      expect(await state.refCount(CID)).toBe(0);
    });
  });

  describe('pins', () => {
    it('reads an unknown CID as no pins', async () => {
      expect(await state.getPins(CID)).toEqual({});
    });

    it('merges per provider and overwrites only the provider written', async () => {
      await state.setPins(CID, { pinata: pinned('p1') });
      await state.setPins(CID, { filebase: pinned('f1') });
      await state.setPins(CID, { pinata: pinned('p2') });

      expect(await state.getPins(CID)).toEqual({
        pinata: pinned('p2'),
        filebase: pinned('f1'),
      });
    });

    it('treats an empty update as a no-op', async () => {
      await state.setPins(CID, {});

      expect(await r.raw.exists(`nc:cid:${CID}:pins`)).toBe(0);
    });

    it('deletes all pins of a CID', async () => {
      await state.setPins(CID, { pinata: pinned('p1') });

      await state.deletePins(CID);

      expect(await state.getPins(CID)).toEqual({});
    });
  });

  describe('pin retry queue', () => {
    const octopin = { provider: 'octopin' as const, cid: CID };
    const other = { provider: 'octopin' as const, cid: 'bafyother' };

    it('returns only entries that are due, earliest first, up to the limit', async () => {
      await state.scheduleRetry(other, 2000);
      await state.scheduleRetry(octopin, 1000);
      await state.scheduleRetry(
        { provider: 'octopin', cid: 'bafylater' },
        9000,
      );

      expect(await state.dueRetries(5000, 10)).toEqual([octopin, other]);
      expect(await state.dueRetries(5000, 1)).toEqual([octopin]);
    });

    it('reschedules an entry instead of duplicating it', async () => {
      await state.scheduleRetry(octopin, 1000);
      await state.scheduleRetry(octopin, 9000);

      expect(await state.dueRetries(5000, 10)).toEqual([]);
      expect(await r.raw.zcard('nc:pin-retry')).toBe(1);
    });

    it('cancels an entry', async () => {
      await state.scheduleRetry(octopin, 1000);

      await state.cancelRetry(octopin);

      expect(await state.dueRetries(5000, 10)).toEqual([]);
    });

    it('stores the octopin request id next to the other providers', async () => {
      await state.setPins(CID, {
        pinata: pinned('p1'),
        filebase: pinned('f1'),
        octopin: {
          status: 'queued',
          ref: 'req-1',
          attempts: 1,
          requestedAt: '2026-11-19T10:00:00.000Z',
          updatedAt: '2026-11-19T10:00:00.000Z',
        },
      });

      expect((await r.raw.hkeys(`nc:cid:${CID}:pins`)).sort()).toEqual([
        'filebase',
        'octopin',
        'pinata',
      ]);
      expect((await state.getPins(CID)).octopin).toMatchObject({
        status: 'queued',
        ref: 'req-1',
      });
    });
  });

  describe('orphans', () => {
    it('records an orphan once and clears it', async () => {
      await state.markOrphan(CID);
      await state.markOrphan(CID);
      expect(await r.raw.smembers('nc:orphans')).toEqual([CID]);

      await state.clearOrphan(CID);
      expect(await r.raw.smembers('nc:orphans')).toEqual([]);
    });
  });
});
