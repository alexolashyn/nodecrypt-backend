import { BadGatewayException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'src/redis/redis.service';
import { PinMap, PinStateRepository, RetryEntry } from './pin-state.repository';
import { PinningService } from './pinning.service';
import {
  PinProvider,
  ProviderName,
  RemotePinState,
} from './providers/pin-provider';

const CID = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am';
const RETRY_INTERVAL_MS = 1000;

class FakeProvider implements PinProvider {
  uploadResult: 'ok' | 'fail' | 'mismatch' = 'ok';
  submitState: RemotePinState;
  checks: (RemotePinState | 'error')[] = [];
  checkCount = 0;
  unpinFails = false;
  uploadDelayMs = 0;
  readonly unpinned: string[] = [];
  readonly calls: string[];
  private requests = 0;

  constructor(
    readonly name: ProviderName,
    readonly pinsByCid = false,
    log: string[] = [],
  ) {
    this.submitState = pinsByCid ? 'queued' : 'pinned';
    this.calls = log;
  }

  async upload(_path: string, cid: string) {
    if (this.uploadDelayMs)
      await new Promise((r) => setTimeout(r, this.uploadDelayMs));
    this.calls.push(`${this.name}.upload`);
    if (this.uploadResult === 'fail') throw new Error('down');
    const actual = this.uploadResult === 'mismatch' ? 'bafyother' : cid;
    this.requests += 1;
    return {
      cid: actual,
      ref: this.pinsByCid ? `req-${this.requests}` : `${this.name}-ref`,
      state: this.submitState,
    };
  }

  check() {
    this.checkCount += 1;
    const next = this.checks.length > 1 ? this.checks.shift()! : this.checks[0];
    if (next === 'error' || next === undefined)
      return Promise.reject(new Error('unreachable'));
    return Promise.resolve(next);
  }

  unpin(_cid: string, ref: string) {
    if (this.unpinFails) return Promise.reject(new Error('down'));
    this.unpinned.push(this.pinsByCid ? ref : _cid);
    return Promise.resolve();
  }
}

class FakeState {
  readonly refs = new Map<string, Set<string>>();
  readonly pins = new Map<string, PinMap>();
  readonly orphans = new Set<string>();
  readonly retries = new Map<string, number>();

  addRef(cid: string, ref: string) {
    this.refs.set(cid, (this.refs.get(cid) ?? new Set()).add(ref));
    return Promise.resolve();
  }
  removeRef(cid: string, ref: string) {
    this.refs.get(cid)?.delete(ref);
    return Promise.resolve();
  }
  refCount(cid: string) {
    return Promise.resolve(this.refs.get(cid)?.size ?? 0);
  }
  getPins(cid: string) {
    return Promise.resolve(structuredClone(this.pins.get(cid) ?? {}));
  }
  setPins(cid: string, pins: PinMap) {
    if (Object.keys(pins).length === 0) return Promise.resolve();
    this.pins.set(cid, { ...this.pins.get(cid), ...structuredClone(pins) });
    return Promise.resolve();
  }
  deletePins(cid: string) {
    this.pins.delete(cid);
    return Promise.resolve();
  }
  markOrphan(cid: string) {
    this.orphans.add(cid);
    return Promise.resolve();
  }
  clearOrphan(cid: string) {
    this.orphans.delete(cid);
    return Promise.resolve();
  }
  scheduleRetry({ provider, cid }: RetryEntry, dueAt: number) {
    this.retries.set(`${provider}:${cid}`, dueAt);
    return Promise.resolve();
  }
  cancelRetry({ provider, cid }: RetryEntry) {
    this.retries.delete(`${provider}:${cid}`);
    return Promise.resolve();
  }
}

class FakeRedis {
  readonly locks = new Map<string, string>();
  acquireLock(key: string) {
    if (this.locks.has(key)) return Promise.resolve(null);
    this.locks.set(key, 'token');
    return Promise.resolve('token');
  }
  releaseLock(key: string) {
    this.locks.delete(key);
    return Promise.resolve();
  }
}

function setup(quorum = 2, { timeoutSeconds = 5, maxAttempts = 3 } = {}) {
  const calls: string[] = [];
  const pinata = new FakeProvider('pinata', false, calls);
  const filebase = new FakeProvider('filebase', false, calls);
  const octopin = new FakeProvider('octopin', true, calls);
  octopin.checks = ['pinned'];
  const state = new FakeState();
  const redis = new FakeRedis();
  const config = new ConfigService({
    PIN_QUORUM: quorum,
    PIN_PROVIDER_TIMEOUT_SECONDS: timeoutSeconds,
    PIN_CONFIRM_POLL_MS: 5,
    PIN_RETRY_INTERVAL_MS: RETRY_INTERVAL_MS,
    PIN_RETRY_MAX_ATTEMPTS: maxAttempts,
  });
  const service = new PinningService(
    [pinata, filebase, octopin],
    state as unknown as PinStateRepository,
    redis as unknown as RedisService,
    config,
  );
  return { service, pinata, filebase, octopin, state, redis, calls };
}

const octopinRetry = (state: FakeState) => state.retries.get(`octopin:${CID}`);

describe('PinningService', () => {
  describe('ensurePinned', () => {
    it('meets 2 of 3 with both uploads and lets octopin finish in the background', async () => {
      const { service, octopin, state } = setup();
      const before = Date.now();

      const pins = await service.ensurePinned(CID, '/tmp/x');

      expect(service.pinnedCount(pins)).toBe(2);
      expect(pins.octopin).toMatchObject({
        status: 'queued',
        ref: 'req-1',
        attempts: 1,
      });
      expect(octopin.checkCount).toBe(0);
      expect(state.pins.get(CID)?.octopin?.ref).toBe('req-1');
      expect(octopinRetry(state)).toBeGreaterThanOrEqual(
        before + RETRY_INTERVAL_MS,
      );
    });

    it('asks octopin only after the first upload is confirmed', async () => {
      const { service, pinata, filebase, calls } = setup();
      pinata.uploadDelayMs = 20;
      filebase.uploadResult = 'fail';

      await service.ensurePinned(CID, '/tmp/x');

      expect(calls).toEqual([
        'filebase.upload',
        'pinata.upload',
        'octopin.upload',
      ]);
    });

    it('needs all three when the quorum is 3', async () => {
      const { service, octopin, state } = setup(3);

      const pins = await service.ensurePinned(CID, '/tmp/x');

      expect(service.pinnedCount(pins)).toBe(3);
      expect(octopin.checkCount).toBeGreaterThan(0);
      expect(octopinRetry(state)).toBeUndefined();
    });

    describe('one of three providers fails', () => {
      it.each(['pinata', 'filebase'] as const)(
        'waits for octopin to confirm when %s is down',
        async (down) => {
          const ctx = setup();
          ctx[down].uploadResult = 'fail';
          ctx.octopin.checks = ['pinning', 'pinned'];

          const pins = await ctx.service.ensurePinned(CID, '/tmp/x');

          expect(pins[down]?.status).toBe('failed');
          expect(pins.octopin?.status).toBe('pinned');
          expect(ctx.octopin.checkCount).toBe(2);
          expect(octopinRetry(ctx.state)).toBeUndefined();
        },
      );

      it('accepts the upload when octopin is down and schedules a retry', async () => {
        const { service, octopin, state } = setup();
        octopin.uploadResult = 'fail';

        const pins = await service.ensurePinned(CID, '/tmp/x');

        expect(service.pinnedCount(pins)).toBe(2);
        expect(pins.octopin).toMatchObject({ status: 'failed', attempts: 1 });
        expect(octopinRetry(state)).toBeDefined();
      });

      it('refuses when octopin cannot fetch the content either', async () => {
        const { service, filebase, pinata, octopin, state } = setup();
        filebase.uploadResult = 'fail';
        octopin.checks = ['failed'];

        await expect(
          service.ensurePinned(CID, '/tmp/x'),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(pinata.unpinned).toEqual([CID]);
        expect(octopin.unpinned).toEqual(['req-1']);
        expect(state.pins.has(CID)).toBe(false);
      });

      it('refuses when octopin stays queued past the provider timeout', async () => {
        const { service, filebase, octopin, state } = setup(2, {
          timeoutSeconds: 0.05,
        });
        filebase.uploadResult = 'fail';
        octopin.checks = ['queued'];

        await expect(
          service.ensurePinned(CID, '/tmp/x'),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(octopin.unpinned).toEqual(['req-1']);
        expect(octopinRetry(state)).toBeUndefined();
      });
    });

    describe('two of three providers fail', () => {
      it('never asks octopin when neither upload succeeded', async () => {
        const { service, pinata, filebase, octopin, state } = setup();
        pinata.uploadResult = 'fail';
        filebase.uploadResult = 'fail';
        const upload = jest.spyOn(octopin, 'upload');

        await expect(
          service.ensurePinned(CID, '/tmp/x'),
        ).rejects.toBeInstanceOf(BadGatewayException);
        expect(upload).not.toHaveBeenCalled();
        expect(state.pins.has(CID)).toBe(false);
      });

      it.each(['pinata', 'filebase'] as const)(
        'rolls back the only copy when %s and octopin are down',
        async (down) => {
          const ctx = setup();
          ctx[down].uploadResult = 'fail';
          ctx.octopin.uploadResult = 'fail';
          const survivor = down === 'pinata' ? ctx.filebase : ctx.pinata;

          await expect(
            ctx.service.ensurePinned(CID, '/tmp/x'),
          ).rejects.toBeInstanceOf(BadGatewayException);
          expect(survivor.unpinned).toEqual([CID]);
          expect(ctx.state.pins.has(CID)).toBe(false);
          expect(ctx.state.retries.size).toBe(0);
        },
      );

      it('still stores with a single provider when the quorum is 1', async () => {
        const { service, pinata, octopin } = setup(1);
        pinata.uploadResult = 'fail';
        octopin.uploadResult = 'fail';

        const pins = await service.ensurePinned(CID, '/tmp/x');

        expect(pins.filebase?.status).toBe('pinned');
      });
    });

    it('never rolls back pins another record depends on', async () => {
      const { service, pinata, filebase, octopin, state } = setup();
      await state.addRef(CID, 'alice:0x1');
      filebase.uploadResult = 'fail';
      octopin.checks = ['failed'];
      await expect(service.ensurePinned(CID, '/tmp/x')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(pinata.unpinned).toEqual([]);
      expect(state.pins.get(CID)?.pinata?.status).toBe('pinned');
      expect(octopinRetry(state)).toBeDefined();
    });

    it('treats a provider-side CID mismatch as a failure and drops its copy', async () => {
      const { service, filebase } = setup(1);
      filebase.uploadResult = 'mismatch';
      const pins = await service.ensurePinned(CID, '/tmp/x');
      expect(pins.filebase?.status).toBe('failed');
      expect(filebase.unpinned).toEqual(['bafyother']);
    });

    it('only pins on providers that do not hold the CID yet', async () => {
      const { service, pinata, octopin, state } = setup();
      await state.setPins(CID, {
        pinata: { status: 'pinned', ref: 'old', updatedAt: '' },
        octopin: { status: 'pinning', ref: 'req-old', updatedAt: '' },
      });
      const upload = jest.spyOn(pinata, 'upload');
      const request = jest.spyOn(octopin, 'upload');
      await service.ensurePinned(CID, '/tmp/x');
      expect(upload).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });

    it('orphans a rollback whose unpin fails', async () => {
      const { service, pinata, filebase, octopin, state } = setup();
      filebase.uploadResult = 'fail';
      octopin.uploadResult = 'fail';
      pinata.unpinFails = true;
      await expect(service.ensurePinned(CID, '/tmp/x')).rejects.toThrow();
      expect(state.orphans.has(CID)).toBe(true);
      expect(state.pins.get(CID)?.pinata?.status).toBe('pinned');
    });
  });

  describe('followUp', () => {
    const entry = { provider: 'octopin' as const, cid: CID };

    async function queued(ctx: ReturnType<typeof setup>) {
      await ctx.service.ensurePinned(CID, '/tmp/x');
      await ctx.state.addRef(CID, 'alice:0x1');
    }

    it('records octopin as pinned once the PSA reports it', async () => {
      const ctx = setup();
      await queued(ctx);

      await ctx.service.followUp(entry);

      expect(ctx.state.pins.get(CID)?.octopin?.status).toBe('pinned');
      expect(octopinRetry(ctx.state)).toBeUndefined();
    });

    it('keeps polling while the PSA is still queued or pinning', async () => {
      const ctx = setup();
      await queued(ctx);
      ctx.octopin.checks = ['pinning'];

      await ctx.service.followUp(entry);

      expect(ctx.state.pins.get(CID)?.octopin?.status).toBe('pinning');
      expect(octopinRetry(ctx.state)).toBeDefined();
      expect(ctx.octopin.unpinned).toEqual([]);
    });

    it('re-requests a failed pin, dropping the old request id', async () => {
      const ctx = setup();
      await queued(ctx);
      ctx.octopin.checks = ['failed'];
      const before = Date.now();

      await ctx.service.followUp(entry);

      expect(ctx.octopin.unpinned).toEqual(['req-1']);
      expect(ctx.state.pins.get(CID)?.octopin).toMatchObject({
        status: 'queued',
        ref: 'req-2',
        attempts: 2,
      });
      expect(octopinRetry(ctx.state)).toBeGreaterThanOrEqual(
        before + RETRY_INTERVAL_MS,
      );
    });

    it('backs off exponentially while the provider stays down', async () => {
      const ctx = setup(2, { maxAttempts: 5 });
      ctx.octopin.uploadResult = 'fail';
      await queued(ctx);
      const before = Date.now();

      await ctx.service.followUp(entry);

      expect(ctx.state.pins.get(CID)?.octopin?.attempts).toBe(2);
      expect(octopinRetry(ctx.state)).toBeGreaterThanOrEqual(
        before + 2 * RETRY_INTERVAL_MS,
      );
    });

    it('gives up after the configured number of attempts', async () => {
      const ctx = setup(2, { maxAttempts: 2 });
      ctx.octopin.uploadResult = 'fail';
      await queued(ctx);

      await ctx.service.followUp(entry);

      expect(ctx.state.pins.get(CID)?.octopin).toMatchObject({
        status: 'failed',
        attempts: 2,
      });
      expect(ctx.state.pins.get(CID)?.octopin?.error).toMatch(/^Gave up/);
      expect(octopinRetry(ctx.state)).toBeUndefined();
    });

    it('re-requests a pin stuck in the queue past the timeout', async () => {
      const ctx = setup(2, { timeoutSeconds: 0.01 });
      await queued(ctx);
      ctx.octopin.checks = ['queued'];
      await new Promise((r) => setTimeout(r, 20));

      await ctx.service.followUp(entry);

      expect(ctx.octopin.unpinned).toEqual(['req-1']);
      expect(ctx.state.pins.get(CID)?.octopin?.ref).toBe('req-2');
    });

    it('drops the retry once the content was released', async () => {
      const ctx = setup();
      await ctx.service.ensurePinned(CID, '/tmp/x');
      await ctx.state.scheduleRetry(entry, 0);
      const check = jest.spyOn(ctx.octopin, 'check');

      await ctx.service.followUp(entry);

      expect(check).not.toHaveBeenCalled();
      expect(octopinRetry(ctx.state)).toBeUndefined();
    });

    it('postpones a CID that is busy', async () => {
      const ctx = setup();
      await queued(ctx);
      await ctx.redis.acquireLock(`nc:lock:cid:${CID}`);

      await ctx.service.followUp(entry);

      expect(ctx.state.pins.get(CID)?.octopin?.status).toBe('queued');
      expect(octopinRetry(ctx.state)).toBeDefined();
    });
  });

  describe('release', () => {
    async function pinnedFor(ctx: ReturnType<typeof setup>, ...refs: string[]) {
      await ctx.service.ensurePinned(CID, '/tmp/x');
      for (const ref of refs) await ctx.state.addRef(CID, ref);
    }

    it('keeps the pin while another record references the CID', async () => {
      const ctx = setup();
      await pinnedFor(ctx, 'alice:0x1', 'mallory:0x2');
      await ctx.service.release(CID, 'mallory:0x2');
      expect(ctx.pinata.unpinned).toEqual([]);
      expect(ctx.state.pins.has(CID)).toBe(true);
    });

    it('unpins on all three, including a request still in flight', async () => {
      const ctx = setup();
      await pinnedFor(ctx, 'alice:0x1');
      await ctx.service.release(CID, 'alice:0x1');
      expect(ctx.pinata.unpinned).toEqual([CID]);
      expect(ctx.filebase.unpinned).toEqual([CID]);
      expect(ctx.octopin.unpinned).toEqual(['req-1']);
      expect(ctx.state.pins.has(CID)).toBe(false);
      expect(octopinRetry(ctx.state)).toBeUndefined();
    });

    it('is idempotent for a retried release', async () => {
      const ctx = setup();
      await pinnedFor(ctx, 'alice:0x1', 'bob:0x3');
      await ctx.service.release(CID, 'alice:0x1');
      await ctx.service.release(CID, 'alice:0x1');
      expect(ctx.pinata.unpinned).toEqual([]);
      expect(await ctx.state.refCount(CID)).toBe(1);
    });

    it('keeps failed unpins on record as orphans', async () => {
      const ctx = setup();
      await pinnedFor(ctx, 'alice:0x1');
      ctx.octopin.unpinFails = true;
      await ctx.service.release(CID, 'alice:0x1');
      expect(ctx.state.orphans.has(CID)).toBe(true);
      expect(Object.keys(ctx.state.pins.get(CID) ?? {})).toEqual(['octopin']);
    });

    it('hands a busy CID to reconciliation instead of failing', async () => {
      const ctx = setup();
      await pinnedFor(ctx, 'alice:0x1');
      await ctx.redis.acquireLock(`nc:lock:cid:${CID}`);
      await ctx.service.release(CID, 'alice:0x1');
      expect(await ctx.state.refCount(CID)).toBe(0);
      expect(ctx.state.orphans.has(CID)).toBe(true);
    });
  });

  it('rejects concurrent work on one CID as retryable', async () => {
    const { service, redis } = setup();
    await redis.acquireLock(`nc:lock:cid:${CID}`);
    await expect(
      service.withCidLock(CID, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
