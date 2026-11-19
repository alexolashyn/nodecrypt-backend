import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HDNodeWallet, Wallet } from 'ethers';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { SiweMessage } from 'siwe';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from 'src/app.module';
import { configureApp } from 'src/app.setup';
import { ChainService, FileRecord } from 'src/chain/chain.service';
import {
  PIN_PROVIDERS,
  PinProvider,
  ProviderName,
} from 'src/pinning/providers/pin-provider';

jest.mock('src/cid/cid.service', () => {
  const crypto =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const fs =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  class FakeCid {
    constructor(readonly value: string) {}
    toString() {
      return this.value;
    }
    equals(other: unknown) {
      return other instanceof FakeCid && other.value === this.value;
    }
  }
  return {
    CID_PROFILE: {},
    CidService: class {
      async computeCid(path: string) {
        const digest = crypto
          .createHash('sha256')
          .update(await fs.readFile(path))
          .digest('hex');
        return new FakeCid(`fake-${digest}`);
      }
      decode(bytes: Uint8Array) {
        const value = Buffer.from(bytes).toString();
        return value.startsWith('fake-') ? new FakeCid(value) : null;
      }
      parse(value: string) {
        return new FakeCid(value);
      }
    },
  };
});

export const cidOf = (content: Buffer) =>
  `fake-${createHash('sha256').update(content).digest('hex')}`;

export class FakeChain {
  private readonly records = new Map<string, FileRecord>();

  register(owner: string, fileId: string, content: Buffer) {
    this.records.set(this.key(owner, fileId), {
      cid: Buffer.from(cidOf(content)),
      sizeBytes: BigInt(content.length),
      removed: false,
      exists: true,
    });
  }

  remove(owner: string, fileId: string) {
    this.records.get(this.key(owner, fileId))!.removed = true;
  }

  getFile(owner: string, fileId: string): Promise<FileRecord> {
    return Promise.resolve(
      this.records.get(this.key(owner, fileId)) ?? {
        cid: new Uint8Array(),
        sizeBytes: 0n,
        removed: false,
        exists: false,
      },
    );
  }

  private key(owner: string, fileId: string) {
    return `${owner.toLowerCase()}:${fileId.toLowerCase()}`;
  }
}

export class FakeProvider implements PinProvider {
  readonly uploads: string[] = [];
  readonly unpinned: string[] = [];

  constructor(
    readonly name: ProviderName,
    readonly pinsByCid = false,
  ) {}

  upload(_path: string, cid: string) {
    this.uploads.push(cid);
    return Promise.resolve({
      cid,
      ref: `${this.name}-ref`,
      state: this.pinsByCid ? ('queued' as const) : ('pinned' as const),
    });
  }

  check() {
    return Promise.resolve('pinned' as const);
  }

  unpin(cid: string) {
    this.unpinned.push(cid);
    return Promise.resolve();
  }
}

export interface TestApp {
  app: INestApplication<App>;
  http: () => ReturnType<typeof request>;
  chain: FakeChain;
  providers: FakeProvider[];
  redis: Redis;
  close(): Promise<void>;
}

export async function createTestApp({
  appProviders = false,
} = {}): Promise<TestApp> {
  const chain = new FakeChain();
  const providers = [
    new FakeProvider('pinata'),
    new FakeProvider('filebase'),
    new FakeProvider('octopin', true),
  ];

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ChainService)
    .useValue(chain);
  if (!appProviders)
    builder = builder.overrideProvider(PIN_PROVIDERS).useValue(providers);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: false,
  });
  configureApp(app);
  await app.init();

  const redis = new Redis(process.env.REDIS_URL!, {
    password: process.env.REDIS_PASSWORD,
  });

  return {
    app,
    http: () => request(app.getHttpServer()),
    chain,
    providers,
    redis,
    close: async () => {
      await app.close();
      await redis.quit();
      await rm(process.env.UPLOAD_TMP_DIR!, { recursive: true, force: true });
    },
  };
}

interface Envelope<T = Record<string, unknown>> {
  success: boolean;
  statusCode: number;
  data: T;
  message: string | string[];
}

export const envelope = <T = Record<string, unknown>>(res: { body: unknown }) =>
  res.body as Envelope<T>;

export interface Session {
  wallet: HDNodeWallet;
  accessToken: string;
  cookie: string;
}

export async function signIn(
  t: TestApp,
  wallet: HDNodeWallet = Wallet.createRandom(),
): Promise<Session> {
  const { nonce } = envelope<{ nonce: string }>(
    await t.http().get('/auth/nonce').expect(200),
  ).data;
  const message = new SiweMessage({
    domain: 'localhost',
    address: wallet.address,
    statement: 'Sign in to NodeCrypt',
    uri: 'http://localhost:5173',
    version: '1',
    chainId: 11155111,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();
  const signature = await wallet.signMessage(message);

  const res = await t
    .http()
    .post('/auth/verify')
    .send({ message, signature })
    .expect(201);
  return {
    wallet,
    accessToken: envelope<{ accessToken: string }>(res).data.accessToken,
    cookie: refreshCookie(res),
  };
}

export function refreshCookie(res: { headers: Record<string, unknown> }) {
  const cookies = res.headers['set-cookie'] as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith('refreshToken='));
  if (!cookie) throw new Error('No refreshToken cookie in the response');
  return cookie;
}
