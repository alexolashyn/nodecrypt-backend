import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { ProviderName, RemotePinState } from './providers/pin-provider';

export type PinStatus = RemotePinState;

export interface ProviderPin {
  status: PinStatus;
  ref?: string;
  error?: string;
  attempts?: number;
  requestedAt?: string;
  updatedAt: string;
}

export type PinMap = Partial<Record<ProviderName, ProviderPin>>;

export interface RetryEntry {
  provider: ProviderName;
  cid: string;
}

@Injectable()
export class PinStateRepository {
  constructor(private readonly redis: RedisService) {}

  static fileRef(owner: string, fileId: string): string {
    return `${owner}:${fileId}`;
  }

  async getFileCid(owner: string, fileId: string): Promise<string | null> {
    const { cid } = await this.redis.hgetall(this.fileKey(owner, fileId));
    return cid ?? null;
  }

  async setFileCid(owner: string, fileId: string, cid: string): Promise<void> {
    await this.redis.hset(this.fileKey(owner, fileId), { cid });
  }

  async deleteFile(owner: string, fileId: string): Promise<void> {
    await this.redis.del(this.fileKey(owner, fileId));
  }

  async addRef(cid: string, fileRef: string): Promise<void> {
    await this.redis.sadd(this.refsKey(cid), fileRef);
  }

  async removeRef(cid: string, fileRef: string): Promise<void> {
    await this.redis.srem(this.refsKey(cid), fileRef);
  }

  async refCount(cid: string): Promise<number> {
    return this.redis.scard(this.refsKey(cid));
  }

  async getPins(cid: string): Promise<PinMap> {
    const raw = await this.redis.hgetall(this.pinsKey(cid));
    return Object.fromEntries(
      Object.entries(raw).map(([provider, json]) => [
        provider,
        JSON.parse(json),
      ]),
    );
  }

  async setPins(cid: string, pins: PinMap): Promise<void> {
    const entries = Object.entries(pins);
    if (entries.length === 0) return;
    await this.redis.hset(
      this.pinsKey(cid),
      Object.fromEntries(entries.map(([p, pin]) => [p, JSON.stringify(pin)])),
    );
  }

  async deletePins(cid: string): Promise<void> {
    await this.redis.del(this.pinsKey(cid));
  }

  async markOrphan(cid: string): Promise<void> {
    await this.redis.sadd(ORPHANS_KEY, cid);
  }

  async clearOrphan(cid: string): Promise<void> {
    await this.redis.srem(ORPHANS_KEY, cid);
  }

  async scheduleRetry(entry: RetryEntry, dueAt: number): Promise<void> {
    await this.redis.zadd(RETRY_KEY, dueAt, retryMember(entry));
  }

  async cancelRetry(entry: RetryEntry): Promise<void> {
    await this.redis.zrem(RETRY_KEY, retryMember(entry));
  }

  async dueRetries(now: number, limit: number): Promise<RetryEntry[]> {
    const members = await this.redis.zdue(RETRY_KEY, now, limit);
    return members.map((member) => {
      const at = member.indexOf(':');
      return {
        provider: member.slice(0, at) as ProviderName,
        cid: member.slice(at + 1),
      };
    });
  }

  private fileKey(owner: string, fileId: string) {
    return `nc:file:${owner}:${fileId}`;
  }

  private refsKey(cid: string) {
    return `nc:cid:${cid}:refs`;
  }

  private pinsKey(cid: string) {
    return `nc:cid:${cid}:pins`;
  }
}

const ORPHANS_KEY = 'nc:orphans';
const RETRY_KEY = 'nc:pin-retry';

function retryMember({ provider, cid }: RetryEntry): string {
  return `${provider}:${cid}`;
}
