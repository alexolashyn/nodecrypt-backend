import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  PayloadTooLargeException,
  RequestTimeoutException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { ChainService, FileRecord } from 'src/chain/chain.service';
import { StageTimer } from 'src/common/timing/stage-timer';
import { CidService } from 'src/cid/cid.service';
import { PinStateRepository, PinMap } from 'src/pinning/pin-state.repository';
import { PinningService } from 'src/pinning/pinning.service';
import { RedisService } from 'src/redis/redis.service';
import { UploadGate } from './upload-gate.service';

export interface FileStatus {
  fileId: string;
  cid: string;
  pinned: boolean;
  quorum: number;
  providers: Record<
    string,
    { status: string; error?: string; attempts?: number; updatedAt?: string }
  >;
}

@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private readonly tmpDir: string;
  private readonly maxUploadBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly chain: ChainService,
    private readonly cids: CidService,
    private readonly pinning: PinningService,
    private readonly state: PinStateRepository,
    private readonly redis: RedisService,
    private readonly gate: UploadGate,
    config: ConfigService,
  ) {
    this.tmpDir = config.getOrThrow('UPLOAD_TMP_DIR');
    this.maxUploadBytes = config.getOrThrow<number>('MAX_UPLOAD_BYTES');
    this.idleTimeoutMs =
      config.getOrThrow<number>('UPLOAD_IDLE_TIMEOUT_SECONDS') * 1000;
    this.requestTimeoutMs =
      config.getOrThrow<number>('UPLOAD_REQUEST_TIMEOUT_SECONDS') * 1000;
  }

  async onModuleInit() {
    await mkdir(this.tmpDir, { recursive: true });
    const cutoff = Date.now() - this.requestTimeoutMs;
    for (const name of await readdir(this.tmpDir)) {
      const path = join(this.tmpDir, name);
      const { mtimeMs } = await stat(path);
      if (mtimeMs < cutoff) await rm(path, { force: true });
    }
  }

  async upload(
    owner: string,
    fileId: string,
    req: Request,
    timer = new StageTimer(),
  ): Promise<FileStatus> {
    const declared = this.declaredLength(req);
    timer.set('sizeBytes', declared);
    const record = await timer.time('chainRead', () =>
      this.requireLiveRecord(owner, fileId),
    );

    if (BigInt(declared) !== record.sizeBytes) {
      throw BigInt(declared) > record.sizeBytes
        ? new PayloadTooLargeException(
            `Body exceeds the registered size of ${record.sizeBytes} bytes`,
          )
        : new BadRequestException(
            `Body is smaller than the registered size of ${record.sizeBytes} bytes`,
          );
    }
    const expected = this.cids.decode(record.cid);
    if (!expected)
      throw new BadRequestException('The on-chain record holds an invalid CID');
    const cid = expected.toString();
    timer.set('cid', cid);
    const fileRef = PinStateRepository.fileRef(owner, fileId);

    return this.withFileLock(
      owner,
      fileId,
      async () => {
        const previous = await this.state.getFileCid(owner, fileId);

        if (await this.pinning.isQuorumMet(cid)) {
          timer.set('path', 'dedup');
          await timer.time('attach', () =>
            this.pinning.withCidLock(cid, async () => {
              if (!(await this.pinning.isQuorumMet(cid))) {
                throw new ConflictException(
                  'Pin state changed during the request; retry',
                );
              }
              await this.state.addRef(cid, fileRef);
            }),
          );
        } else {
          timer.set('path', 'upload');
          const gateStart = performance.now();
          await this.gate.run(owner, async () => {
            timer.since('gate', gateStart);
            const tmp = await timer.time('receiveBody', () =>
              this.receiveBody(req, Number(record.sizeBytes)),
            );
            try {
              const actual = await timer.time('computeCid', () =>
                this.cids.computeCid(tmp),
              );
              if (!actual.equals(expected)) {
                throw new BadRequestException(
                  `Content hashes to ${actual.toString()}, but the on-chain record says ${cid}`,
                );
              }
              await this.pinning.withCidLock(cid, async () => {
                await timer.time('quorum', () =>
                  this.pinning.ensurePinned(cid, tmp, timer),
                );
                await this.state.addRef(cid, fileRef);
              });
            } finally {
              await rm(tmp, { force: true });
            }
          });
        }

        return timer.time('finalize', async () => {
          await this.state.setFileCid(owner, fileId, cid);
          if (previous && previous !== cid)
            await this.pinning.release(previous, fileRef);
          return this.toStatus(fileId, cid, await this.state.getPins(cid));
        });
      },
      timer,
    );
  }

  async remove(
    owner: string,
    fileId: string,
  ): Promise<{ fileId: string; released: boolean }> {
    const record = await this.chain.getFile(owner, fileId);
    if (!record.exists)
      throw new NotFoundException('File is not registered on-chain');
    if (!record.removed)
      throw new ConflictException('File has not been removed on-chain');

    return this.withFileLock(owner, fileId, async () => {
      const cid = await this.state.getFileCid(owner, fileId);
      if (!cid) return { fileId, released: false };

      await this.pinning.release(
        cid,
        PinStateRepository.fileRef(owner, fileId),
      );
      await this.state.deleteFile(owner, fileId);
      return { fileId, released: true };
    });
  }

  async status(owner: string, fileId: string): Promise<FileStatus> {
    const cid = await this.state.getFileCid(owner, fileId);
    if (!cid) throw new NotFoundException('Nothing is pinned for this file');
    return this.toStatus(fileId, cid, await this.state.getPins(cid));
  }

  private declaredLength(req: Request): number {
    const header = req.headers['content-length'];
    if (!header) {
      throw new HttpException(
        'Content-Length is required',
        HttpStatus.LENGTH_REQUIRED,
      );
    }
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new BadRequestException('Invalid Content-Length');
    }
    if (length > this.maxUploadBytes) {
      throw new PayloadTooLargeException(
        `Uploads are capped at ${this.maxUploadBytes} bytes by this server`,
      );
    }
    return length;
  }

  private async requireLiveRecord(
    owner: string,
    fileId: string,
  ): Promise<FileRecord> {
    const record = await this.chain.getFile(owner, fileId);
    if (!record.exists)
      throw new NotFoundException('File is not registered on-chain');
    if (record.removed) throw new GoneException('File was removed on-chain');
    return record;
  }

  private async receiveBody(req: Request, expected: number): Promise<string> {
    const path = join(this.tmpDir, randomUUID());
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        if (received > expected) {
          done(
            new PayloadTooLargeException(
              `Body exceeds the registered size of ${expected} bytes`,
            ),
          );
        } else {
          done(null, chunk);
        }
      },
    });
    req.setTimeout(this.idleTimeoutMs, () =>
      req.destroy(new RequestTimeoutException('Upload stalled')),
    );

    try {
      await pipeline(req, limiter, createWriteStream(path, { flags: 'wx' }));
    } catch (err) {
      await rm(path, { force: true });
      if (err instanceof HttpException) throw err;
      throw new BadRequestException('Upload was interrupted');
    } finally {
      req.setTimeout(0);
    }
    if (received !== expected) {
      await rm(path, { force: true });
      throw new BadRequestException(
        `Received ${received} bytes, expected ${expected}`,
      );
    }
    return path;
  }

  private async withFileLock<T>(
    owner: string,
    fileId: string,
    fn: () => Promise<T>,
    timer = new StageTimer(),
  ): Promise<T> {
    const key = `nc:lock:file:${owner}:${fileId}`;
    const token = await timer.time('fileLock', () =>
      this.redis.acquireLock(key, this.requestTimeoutMs + 60_000),
    );
    if (!token)
      throw new ConflictException(
        'Another request for this file is in progress',
      );
    try {
      return await fn();
    } finally {
      await this.redis.releaseLock(key, token);
    }
  }

  private toStatus(fileId: string, cid: string, pins: PinMap): FileStatus {
    return {
      fileId,
      cid,
      pinned: this.pinning.pinnedCount(pins) >= this.pinning.quorum,
      quorum: this.pinning.quorum,
      providers: Object.fromEntries(
        this.pinning.providerNames.map((name) => {
          const pin = pins[name];
          return [
            name,
            pin
              ? {
                  status: pin.status,
                  error: pin.error,
                  attempts: pin.attempts,
                  updatedAt: pin.updatedAt,
                }
              : { status: 'absent' },
          ];
        }),
      ),
    };
  }
}
