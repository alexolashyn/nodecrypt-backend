import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { StageTimer } from 'src/common/timing/stage-timer';
import { RedisService } from 'src/redis/redis.service';
import {
  PinMap,
  PinStateRepository,
  ProviderPin,
  RetryEntry,
} from './pin-state.repository';
import {
  PIN_PROVIDERS,
  PinProvider,
  ProviderName,
} from './providers/pin-provider';

const MAX_BACKOFF_MS = 3_600_000;

interface Held {
  provider: PinProvider;
  ref: string;
}

@Injectable()
export class PinningService {
  private readonly logger = new Logger(PinningService.name);
  readonly quorum: number;
  private readonly providerTimeoutMs: number;
  private readonly confirmPollMs: number;
  private readonly retryIntervalMs: number;
  private readonly retryMaxAttempts: number;

  constructor(
    @Inject(PIN_PROVIDERS) private readonly providers: PinProvider[],
    private readonly state: PinStateRepository,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.quorum = config.getOrThrow<number>('PIN_QUORUM');
    this.providerTimeoutMs =
      config.getOrThrow<number>('PIN_PROVIDER_TIMEOUT_SECONDS') * 1000;
    this.confirmPollMs = config.get<number>('PIN_CONFIRM_POLL_MS') ?? 2000;
    this.retryIntervalMs =
      config.get<number>('PIN_RETRY_INTERVAL_MS') ?? 30_000;
    this.retryMaxAttempts = config.get<number>('PIN_RETRY_MAX_ATTEMPTS') ?? 5;
  }

  get providerNames(): ProviderName[] {
    return this.providers.map((p) => p.name);
  }

  pinnedCount(pins: PinMap): number {
    return Object.values(pins).filter((p) => p?.status === 'pinned').length;
  }

  async isQuorumMet(cid: string): Promise<boolean> {
    return this.pinnedCount(await this.state.getPins(cid)) >= this.quorum;
  }

  async withCidLock<T>(cid: string, fn: () => Promise<T>): Promise<T> {
    const key = `nc:lock:cid:${cid}`;
    const token = await this.redis.acquireLock(
      key,
      3 * this.providerTimeoutMs + 60_000,
    );
    if (!token) {
      throw new ConflictException(
        'This content is being pinned or released; retry shortly',
      );
    }
    try {
      return await fn();
    } finally {
      await this.redis.releaseLock(key, token);
    }
  }

  async ensurePinned(
    cid: string,
    path: string,
    timer = new StageTimer(),
  ): Promise<PinMap> {
    const existing = await this.state.getPins(cid);
    const merged: PinMap = { ...existing };
    const fresh = new Set<ProviderName>();

    const uploads = this.providers
      .filter((p) => !p.pinsByCid && existing[p.name]?.status !== 'pinned')
      .map(async (provider) => {
        const pin = await timer.time(`pin.${provider.name}`, () =>
          this.submit(provider, cid, path),
        );
        merged[provider.name] = pin;
        fresh.add(provider.name);
        return pin;
      });
    const sourced = this.hasSource(merged)
      ? Promise.resolve(true)
      : firstPinned(uploads);

    const requests = this.providers
      .filter((p) => p.pinsByCid && !isLive(existing[p.name]))
      .map(async (provider) => {
        if (!(await sourced)) {
          merged[provider.name] = {
            status: 'failed',
            error: 'No provider holds the content on IPFS to pin it from',
            updatedAt: new Date().toISOString(),
          };
          return;
        }
        const stale = existing[provider.name]?.ref;
        if (stale) await this.unpinEach(cid, [{ provider, ref: stale }]);
        merged[provider.name] = await timer.time(`pin.${provider.name}`, () =>
          this.submit(provider, cid, path),
        );
        fresh.add(provider.name);
      });

    await Promise.all([...uploads, ...requests]);

    if (this.pinnedCount(merged) < this.quorum)
      await timer.time('confirm', () => this.confirm(cid, merged));

    if (this.pinnedCount(merged) >= this.quorum) {
      await this.state.setPins(cid, merged);
      await this.scheduleFollowUps(cid, merged);
      return merged;
    }

    if ((await this.state.refCount(cid)) === 0) {
      const failed = await this.unpinEach(cid, this.held(merged, fresh));
      if (failed.length > 0) {
        await this.state.setPins(
          cid,
          Object.fromEntries(
            failed.map((f) => [f.provider.name, merged[f.provider.name]]),
          ),
        );
        await this.state.markOrphan(cid);
      }
    } else {
      await this.state.setPins(cid, merged);
      await this.scheduleFollowUps(cid, merged);
    }

    throw new BadGatewayException({
      message: `Pinned on ${this.pinnedCount(merged)} of ${this.providers.length} providers, quorum is ${this.quorum}`,
      providers: merged,
    });
  }

  async release(cid: string, fileRef: string): Promise<void> {
    await this.state.removeRef(cid, fileRef);
    try {
      await this.withCidLock(cid, async () => {
        if ((await this.state.refCount(cid)) > 0) return;

        const pins = await this.state.getPins(cid);
        const failed = await this.unpinEach(cid, this.held(pins));
        for (const provider of this.providers.filter((p) => p.pinsByCid))
          await this.state.cancelRetry({ provider: provider.name, cid });

        await this.state.deletePins(cid);
        if (failed.length === 0) {
          await this.state.clearOrphan(cid);
          return;
        }
        await this.state.setPins(
          cid,
          Object.fromEntries(
            failed.map((f) => [f.provider.name, pins[f.provider.name]]),
          ),
        );
        await this.state.markOrphan(cid);
      });
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
      await this.state.markOrphan(cid);
    }
  }

  async followUp(entry: RetryEntry): Promise<void> {
    const provider = this.providers.find(
      (p) => p.name === entry.provider && p.pinsByCid,
    );
    if (!provider) return this.state.cancelRetry(entry);

    try {
      await this.withCidLock(entry.cid, async () => {
        const pin = (await this.state.getPins(entry.cid))[provider.name];
        if (
          !pin ||
          pin.status === 'pinned' ||
          (await this.state.refCount(entry.cid)) === 0
        )
          return this.state.cancelRetry(entry);

        const next = this.exhausted(
          await this.advance(provider, entry.cid, pin),
        );
        await this.state.setPins(entry.cid, { [provider.name]: next });
        await this.reschedule(entry, next);
      });
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
      await this.state.scheduleRetry(entry, Date.now() + this.retryIntervalMs);
    }
  }

  private async advance(
    provider: PinProvider,
    cid: string,
    pin: ProviderPin,
  ): Promise<ProviderPin> {
    const updatedAt = new Date().toISOString();
    const attempts = pin.attempts ?? 1;

    if (isPending(pin)) {
      const stale =
        Date.now() - Date.parse(pin.requestedAt ?? pin.updatedAt) >
        this.providerTimeoutMs;
      try {
        const status = await this.check(provider, cid, pin.ref!);
        if (status === 'pinned' || (status !== 'failed' && !stale))
          return { ...pin, status, error: undefined, updatedAt };
        pin = {
          ...pin,
          status: 'failed',
          error:
            status === 'failed'
              ? `${provider.name} could not fetch the content`
              : `${provider.name} stayed ${status} for over ${this.providerTimeoutMs / 1000} s`,
        };
      } catch (err) {
        if (!stale) return { ...pin, error: String(err), updatedAt };
        pin = { ...pin, status: 'failed', error: String(err) };
      }
    }

    if (attempts >= this.retryMaxAttempts)
      return this.exhausted({ ...pin, status: 'failed', updatedAt });
    if (pin.ref) {
      const failed = await this.unpinEach(cid, [{ provider, ref: pin.ref }]);
      if (failed.length > 0)
        return {
          ...pin,
          status: 'failed',
          attempts: attempts + 1,
          error: `Could not cancel the previous ${provider.name} request`,
          updatedAt,
        };
    }
    return this.submit(provider, cid, '', attempts);
  }

  private exhausted(pin: ProviderPin): ProviderPin {
    const attempts = pin.attempts ?? 1;
    if (
      pin.status !== 'failed' ||
      attempts < this.retryMaxAttempts ||
      pin.error?.startsWith('Gave up')
    )
      return pin;
    return {
      ...pin,
      error: `Gave up after ${attempts} attempts: ${pin.error ?? 'unknown error'}`,
    };
  }

  private async reschedule(entry: RetryEntry, pin: ProviderPin) {
    if (pin.status === 'pinned') return this.state.cancelRetry(entry);
    if (isPending(pin))
      return this.state.scheduleRetry(entry, Date.now() + this.retryIntervalMs);
    const attempts = pin.attempts ?? 1;
    if (attempts >= this.retryMaxAttempts) {
      this.logger.error(
        `${entry.provider} gave up on ${entry.cid} after ${attempts} attempts`,
      );
      return this.state.cancelRetry(entry);
    }
    const backoff = Math.min(
      this.retryIntervalMs * 2 ** (attempts - 1),
      MAX_BACKOFF_MS,
    );
    return this.state.scheduleRetry(entry, Date.now() + backoff);
  }

  private async scheduleFollowUps(cid: string, pins: PinMap) {
    for (const provider of this.providers.filter((p) => p.pinsByCid)) {
      const pin = pins[provider.name];
      if (pin && pin.status !== 'pinned')
        await this.reschedule({ provider: provider.name, cid }, pin);
    }
  }

  private async confirm(cid: string, pins: PinMap): Promise<void> {
    const deadline = Date.now() + this.providerTimeoutMs;
    const pending = () =>
      this.providers.filter((p) => p.check && isPending(pins[p.name]));

    while (
      this.pinnedCount(pins) < this.quorum &&
      this.pinnedCount(pins) + pending().length >= this.quorum &&
      Date.now() < deadline
    ) {
      await sleep(this.confirmPollMs);
      await Promise.all(
        pending().map(async (provider) => {
          const pin = pins[provider.name]!;
          try {
            const status = await this.check(provider, cid, pin.ref!);
            pins[provider.name] = {
              ...pin,
              status,
              error:
                status === 'failed'
                  ? `${provider.name} could not fetch the content`
                  : undefined,
              updatedAt: new Date().toISOString(),
            };
          } catch (err) {
            this.logger.warn(`${provider.name} check of ${cid} failed: ${err}`);
          }
        }),
      );
    }
  }

  private check(provider: PinProvider, cid: string, ref: string) {
    return provider.check!(
      cid,
      ref,
      AbortSignal.timeout(this.providerTimeoutMs),
    );
  }

  private hasSource(pins: PinMap): boolean {
    return this.providers.some(
      (p) => !p.pinsByCid && pins[p.name]?.status === 'pinned',
    );
  }

  private held(pins: PinMap, only?: Set<ProviderName>): Held[] {
    return this.providers
      .filter((p) => (!only || only.has(p.name)) && pins[p.name]?.ref)
      .map((provider) => ({ provider, ref: pins[provider.name]!.ref! }));
  }

  private async submit(
    provider: PinProvider,
    cid: string,
    path: string,
    previousAttempts = 0,
  ): Promise<ProviderPin> {
    const updatedAt = new Date().toISOString();
    const tracking = provider.pinsByCid
      ? { attempts: previousAttempts + 1, requestedAt: updatedAt }
      : {};
    try {
      const uploaded = await provider.upload(
        path,
        cid,
        AbortSignal.timeout(this.providerTimeoutMs),
      );
      if (uploaded.cid !== cid) {
        await this.unpinEach(uploaded.cid, [{ provider, ref: uploaded.ref }]);
        return {
          status: 'failed',
          error: `CID mismatch: provider produced ${uploaded.cid}`,
          ...tracking,
          updatedAt,
        };
      }
      return {
        status: uploaded.state,
        ref: uploaded.ref,
        ...(uploaded.state === 'failed' && {
          error: `${provider.name} could not fetch the content`,
        }),
        ...tracking,
        updatedAt,
      };
    } catch (err) {
      this.logger.warn(`${provider.name} pin of ${cid} failed: ${err}`);
      return { status: 'failed', error: String(err), ...tracking, updatedAt };
    }
  }

  private async unpinEach(cid: string, targets: Held[]): Promise<Held[]> {
    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          await target.provider.unpin(
            cid,
            target.ref,
            AbortSignal.timeout(this.providerTimeoutMs),
          );
          return null;
        } catch (err) {
          this.logger.error(
            `${target.provider.name} unpin of ${cid} failed: ${err}`,
          );
          return target;
        }
      }),
    );
    return results.filter((r) => r !== null);
  }
}

function isPending(pin?: ProviderPin): boolean {
  return (pin?.status === 'queued' || pin?.status === 'pinning') && !!pin.ref;
}

function isLive(pin?: ProviderPin): boolean {
  return pin?.status === 'pinned' || isPending(pin);
}

function firstPinned(uploads: Promise<ProviderPin>[]): Promise<boolean> {
  return new Promise((resolve) => {
    let left = uploads.length;
    if (left === 0) return resolve(false);
    for (const upload of uploads)
      void upload.then((pin) => {
        if (pin.status === 'pinned') resolve(true);
        else if (--left === 0) resolve(false);
      });
  });
}
