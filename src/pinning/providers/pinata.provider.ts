import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openAsBlob } from 'node:fs';
import { PinProvider, ProviderHttpError, UploadedPin } from './pin-provider';

const UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
const FILES_URL = 'https://api.pinata.cloud/v3/files/public';

@Injectable()
export class PinataProvider implements PinProvider {
  readonly name = 'pinata' as const;
  readonly pinsByCid = false;
  private readonly authHeader: string;

  constructor(config: ConfigService) {
    this.authHeader = `Bearer ${config.getOrThrow<string>('PINATA_JWT')}`;
  }

  async upload(
    path: string,
    cid: string,
    signal: AbortSignal,
  ): Promise<UploadedPin> {
    const form = new FormData();
    form.append('file', await openAsBlob(path), cid);
    form.append('network', 'public');
    form.append('name', cid);

    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: this.authHeader },
      body: form,
      signal,
    });
    if (!res.ok)
      throw new ProviderHttpError(this.name, res.status, await res.text());

    const { data } = (await res.json()) as {
      data: { id: string; cid: string };
    };
    return { cid: data.cid, ref: data.id, state: 'pinned' };
  }

  async unpin(_cid: string, ref: string, signal: AbortSignal): Promise<void> {
    const res = await fetch(`${FILES_URL}/${encodeURIComponent(ref)}`, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (res.ok || res.status === 404) return;
    throw new ProviderHttpError(this.name, res.status, await res.text());
  }
}
