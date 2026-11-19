import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, JsonRpcProvider, getBytes } from 'ethers';
import { FILE_REGISTRY_ABI, STORAGE_TIER_ABI } from './abi';

export interface FileRecord {
  cid: Uint8Array;
  sizeBytes: bigint;
  removed: boolean;
  exists: boolean;
}

interface RawFileRecord {
  cid: string;
  sizeBytes: bigint;
  removed: boolean;
  exists: boolean;
}

const NOT_FOUND_RETRIES = 3;
const NOT_FOUND_RETRY_DELAY_MS = 1000;

@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger(ChainService.name);
  private readonly provider: JsonRpcProvider;
  private readonly fileRegistry: Contract;
  private readonly storageTier: Contract;

  constructor(private readonly config: ConfigService) {
    this.provider = new JsonRpcProvider(
      config.getOrThrow('RPC_URL'),
      config.getOrThrow<number>('CHAIN_ID'),
      { staticNetwork: true },
    );
    this.fileRegistry = new Contract(
      config.getOrThrow('FILE_REGISTRY_ADDRESS'),
      FILE_REGISTRY_ABI,
      this.provider,
    );
    this.storageTier = new Contract(
      config.getOrThrow('STORAGE_TIER_ADDRESS'),
      STORAGE_TIER_ABI,
      this.provider,
    );
  }

  async onModuleInit() {
    const expected = BigInt(this.config.getOrThrow<number>('CHAIN_ID'));
    const actual = BigInt(
      (await this.provider.send('eth_chainId', [])) as string,
    );
    if (actual !== expected) {
      throw new Error(`RPC is on chain ${actual}, expected ${expected}`);
    }

    for (const contract of [this.fileRegistry, this.storageTier]) {
      const address = await contract.getAddress();
      if ((await this.provider.getCode(address)) === '0x') {
        throw new Error(
          `No contract deployed at ${address} on chain ${actual}`,
        );
      }
    }

    await this.warnIfUploadCapBelowTier();
  }

  async getFile(owner: string, fileId: string): Promise<FileRecord> {
    for (let attempt = 1; ; attempt++) {
      const raw = (await this.fileRegistry.getFile(
        owner,
        fileId,
      )) as RawFileRecord;
      const record: FileRecord = {
        cid: getBytes(raw.cid),
        sizeBytes: raw.sizeBytes,
        removed: raw.removed,
        exists: raw.exists,
      };
      if (record.exists || attempt >= NOT_FOUND_RETRIES) return record;
      await new Promise((r) => setTimeout(r, NOT_FOUND_RETRY_DELAY_MS));
    }
  }

  private async warnIfUploadCapBelowTier() {
    const cap = BigInt(this.config.getOrThrow<number>('MAX_UPLOAD_BYTES'));
    const premiumMax = (await this.storageTier.premiumMaxFileBytes()) as bigint;
    const freeMax = (await this.storageTier.freeMaxFileBytes()) as bigint;
    if (premiumMax > cap || freeMax > cap) {
      this.logger.warn(
        `MAX_UPLOAD_BYTES (${cap}) is below the on-chain tier limits ` +
          `(free ${freeMax}, premium ${premiumMax}); larger registered files will be refused`,
      );
    }
  }
}
