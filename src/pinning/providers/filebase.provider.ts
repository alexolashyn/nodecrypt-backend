import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openAsBlob } from 'node:fs';
import { CID_PROFILE } from 'src/cid/cid.service';
import { PinProvider, ProviderHttpError, UploadedPin } from './pin-provider';

const RPC_URL = 'https://rpc.filebase.io/api/v0';

@Injectable()
export class FilebaseProvider implements PinProvider {
  readonly name = 'filebase' as const;
  readonly pinsByCid = false;
  private readonly authHeader: string;

  constructor(config: ConfigService) {
    this.authHeader = `Bearer ${config.getOrThrow<string>('FILEBASE_RPC_TOKEN')}`;
  }

  async upload(
    path: string,
    cid: string,
    signal: AbortSignal,
  ): Promise<UploadedPin> {
    const params = new URLSearchParams({
      'cid-version': String(CID_PROFILE.cidVersion),
      'raw-leaves': String(CID_PROFILE.rawLeaves),
      chunker: `size-${CID_PROFILE.chunkSize}`,
      pin: 'true',
    });
    const form = new FormData();
    form.append('file', await openAsBlob(path), cid);

    const res = await fetch(`${RPC_URL}/add?${params}`, {
      method: 'POST',
      headers: { Authorization: this.authHeader },
      body: form,
      signal,
    });
    if (!res.ok)
      throw new ProviderHttpError(this.name, res.status, await res.text());

    const lines = (await res.text()).trim().split('\n');
    const { Hash } = JSON.parse(lines[lines.length - 1]) as { Hash: string };
    return { cid: Hash, ref: Hash, state: 'pinned' };
  }

  async unpin(cid: string, _ref: string, signal: AbortSignal): Promise<void> {
    const res = await fetch(
      `${RPC_URL}/pin/rm?${new URLSearchParams({ arg: cid })}`,
      {
        method: 'POST',
        headers: { Authorization: this.authHeader },
        signal,
      },
    );
    if (res.ok) return;
    const body = await res.text();
    if (/not pinned/i.test(body)) return;
    throw new ProviderHttpError(this.name, res.status, body);
  }
}
