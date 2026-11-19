import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FilesService } from './files.service';

jest.mock('src/cid/cid.service', () => ({ CidService: class {} }));
jest.mock('src/chain/chain.service', () => ({ ChainService: class {} }));

const OWNER = '0xowner';
const FILE_ID = `0x${'ab'.repeat(32)}`;
const CID = 'bafy-expected';
const BODY = Buffer.from('hello');

const expectedCid = {
  toString: () => CID,
  equals: (o: unknown) => o === expectedCid,
};
const otherCid = { toString: () => 'bafy-other', equals: () => false };

function request(body: Buffer, contentLength?: number): Request {
  const req = Readable.from([body]) as unknown as Request;
  req.headers =
    contentLength === undefined
      ? {}
      : { 'content-length': String(contentLength) };
  req.setTimeout = () => req;
  return req;
}

async function setup() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'files-'));
  const chain = {
    getFile: jest.fn().mockResolvedValue({
      cid: new Uint8Array([1]),
      sizeBytes: BigInt(BODY.length),
      removed: false,
      exists: true,
    }),
  };
  const cids = {
    decode: jest.fn().mockReturnValue(expectedCid),
    computeCid: jest.fn().mockResolvedValue(expectedCid),
  };
  const pinning = {
    quorum: 1,
    providerNames: ['pinata', 'filebase', 'octopin'],
    pinnedCount: () => 1,
    isQuorumMet: jest.fn().mockResolvedValue(false),
    withCidLock: jest.fn((_cid: string, fn: () => Promise<unknown>) => fn()),
    ensurePinned: jest.fn().mockResolvedValue({}),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const state = {
    getFileCid: jest.fn().mockResolvedValue(null),
    setFileCid: jest.fn().mockResolvedValue(undefined),
    addRef: jest.fn().mockResolvedValue(undefined),
    getPins: jest.fn().mockResolvedValue({}),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const redis = {
    acquireLock: jest.fn().mockResolvedValue('token'),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
  const gate = { run: (_owner: string, fn: () => Promise<unknown>) => fn() };
  const config = new ConfigService({
    UPLOAD_TMP_DIR: tmpDir,
    MAX_UPLOAD_BYTES: 1000,
    UPLOAD_IDLE_TIMEOUT_SECONDS: 5,
    UPLOAD_REQUEST_TIMEOUT_SECONDS: 60,
  });

  const service = new FilesService(
    chain as never,
    cids as never,
    pinning as never,
    state as never,
    redis as never,
    gate as never,
    config,
  );
  const tmpFiles = () => readdir(tmpDir);
  return { service, chain, cids, pinning, state, redis, tmpDir, tmpFiles };
}

describe('FilesService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  describe('upload — checks before the body is read', () => {
    it('requires Content-Length', async () => {
      const err = await ctx.service
        .upload(OWNER, FILE_ID, request(BODY))
        .catch((e: unknown) => e as HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.LENGTH_REQUIRED,
      );
      expect(ctx.chain.getFile).not.toHaveBeenCalled();
    });

    it('enforces the server cap without touching the chain', async () => {
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, 1001)),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(ctx.chain.getFile).not.toHaveBeenCalled();
    });

    it('refuses a record removed on-chain', async () => {
      ctx.chain.getFile.mockResolvedValue({ exists: true, removed: true });
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length)),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('refuses a Content-Length that disagrees with the record', async () => {
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length + 1)),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length - 1)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.redis.acquireLock).not.toHaveBeenCalled();
    });
  });

  describe('upload — body', () => {
    it('cuts a body that outgrows a lying Content-Length and cleans up', async () => {
      const lie = request(Buffer.from('hello world'), BODY.length);
      await expect(
        ctx.service.upload(OWNER, FILE_ID, lie),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(await ctx.tmpFiles()).toEqual([]);
      expect(ctx.redis.releaseLock).toHaveBeenCalled();
    });

    it('rejects bytes that do not hash to the on-chain CID', async () => {
      ctx.cids.computeCid.mockResolvedValue(otherCid);
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.pinning.ensurePinned).not.toHaveBeenCalled();
      expect(await ctx.tmpFiles()).toEqual([]);
    });

    it('pins verified bytes, records the reference and removes the temp file', async () => {
      const status = await ctx.service.upload(
        OWNER,
        FILE_ID,
        request(BODY, BODY.length),
      );
      expect(ctx.pinning.ensurePinned).toHaveBeenCalledWith(
        CID,
        expect.any(String),
        expect.anything(),
      );
      expect(ctx.state.addRef).toHaveBeenCalledWith(CID, `${OWNER}:${FILE_ID}`);
      expect(ctx.state.setFileCid).toHaveBeenCalledWith(OWNER, FILE_ID, CID);
      expect(status).toMatchObject({ fileId: FILE_ID, cid: CID, pinned: true });
      expect(await ctx.tmpFiles()).toEqual([]);
    });
  });

  describe('upload — existing state', () => {
    it('attaches to already-pinned content without reading the body', async () => {
      ctx.pinning.isQuorumMet.mockResolvedValue(true);
      await ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length));
      expect(ctx.cids.computeCid).not.toHaveBeenCalled();
      expect(ctx.pinning.ensurePinned).not.toHaveBeenCalled();
      expect(ctx.state.addRef).toHaveBeenCalledWith(CID, `${OWNER}:${FILE_ID}`);
    });

    it('releases the previous CID after replaceFile, only once the new one is pinned', async () => {
      ctx.state.getFileCid.mockResolvedValue('bafy-previous');
      await ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length));
      expect(ctx.pinning.release).toHaveBeenCalledWith(
        'bafy-previous',
        `${OWNER}:${FILE_ID}`,
      );
      expect(ctx.pinning.ensurePinned.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.pinning.release.mock.invocationCallOrder[0],
      );
    });

    it('keeps the previous CID when pinning the new one fails', async () => {
      ctx.state.getFileCid.mockResolvedValue('bafy-previous');
      ctx.pinning.ensurePinned.mockRejectedValue(new Error('quorum'));
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length)),
      ).rejects.toThrow('quorum');
      expect(ctx.pinning.release).not.toHaveBeenCalled();
      expect(ctx.state.setFileCid).not.toHaveBeenCalled();
    });

    it('turns away a concurrent request for the same file', async () => {
      ctx.redis.acquireLock.mockResolvedValue(null);
      await expect(
        ctx.service.upload(OWNER, FILE_ID, request(BODY, BODY.length)),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('refuses while the record is still live on-chain', async () => {
      await expect(ctx.service.remove(OWNER, FILE_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ctx.pinning.release).not.toHaveBeenCalled();
    });

    it('releases what this backend pinned, not what the chain shows', async () => {
      ctx.chain.getFile.mockResolvedValue({ exists: true, removed: true });
      ctx.state.getFileCid.mockResolvedValue('bafy-we-pinned');
      await expect(ctx.service.remove(OWNER, FILE_ID)).resolves.toEqual({
        fileId: FILE_ID,
        released: true,
      });
      expect(ctx.pinning.release).toHaveBeenCalledWith(
        'bafy-we-pinned',
        `${OWNER}:${FILE_ID}`,
      );
      expect(ctx.state.deleteFile).toHaveBeenCalledWith(OWNER, FILE_ID);
    });

    it('is a no-op for a record that was never pinned', async () => {
      ctx.chain.getFile.mockResolvedValue({ exists: true, removed: true });
      await expect(ctx.service.remove(OWNER, FILE_ID)).resolves.toEqual({
        fileId: FILE_ID,
        released: false,
      });
    });
  });
});
