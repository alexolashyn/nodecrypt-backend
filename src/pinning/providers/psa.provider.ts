import {
  PinProvider,
  ProviderHttpError,
  ProviderName,
  RemotePinState,
  UploadedPin,
} from './pin-provider';

interface PsaPinStatus {
  requestid: string;
  status: RemotePinState;
  pin: { cid: string };
}

const STATES: readonly RemotePinState[] = [
  'queued',
  'pinning',
  'pinned',
  'failed',
];

export class PsaPinProvider implements PinProvider {
  readonly pinsByCid = true;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(
    readonly name: ProviderName,
    baseUrl: string,
    apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authHeader = `Bearer ${apiKey}`;
  }

  async upload(
    _path: string,
    cid: string,
    signal: AbortSignal,
  ): Promise<UploadedPin> {
    const res = await fetch(`${this.baseUrl}/pins`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cid, name: cid }),
      signal,
    });
    if (!res.ok)
      throw new ProviderHttpError(this.name, res.status, await res.text());

    const body = this.parse(await res.json());
    return { cid: body.pin.cid, ref: body.requestid, state: body.status };
  }

  async check(
    _cid: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<RemotePinState> {
    const res = await fetch(`${this.baseUrl}/pins/${encodeURIComponent(ref)}`, {
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (res.status === 404) return 'failed';
    if (!res.ok)
      throw new ProviderHttpError(this.name, res.status, await res.text());
    return this.parse(await res.json()).status;
  }

  async unpin(_cid: string, ref: string, signal: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/pins/${encodeURIComponent(ref)}`, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (res.ok || res.status === 404) return;
    throw new ProviderHttpError(this.name, res.status, await res.text());
  }

  private parse(body: unknown): PsaPinStatus {
    const status = body as Partial<PsaPinStatus> | null;
    if (
      typeof status?.requestid !== 'string' ||
      typeof status.pin?.cid !== 'string' ||
      !STATES.includes(status.status as RemotePinState)
    ) {
      throw new Error(
        `${this.name} returned an invalid pin status: ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    return status as PsaPinStatus;
  }
}
