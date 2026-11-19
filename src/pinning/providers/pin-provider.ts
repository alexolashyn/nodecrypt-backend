export const PROVIDER_NAMES = ['pinata', 'filebase', 'octopin'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type RemotePinState = 'queued' | 'pinning' | 'pinned' | 'failed';

export interface UploadedPin {
  cid: string;
  ref: string;
  state: RemotePinState;
}

export interface PinProvider {
  readonly name: ProviderName;
  readonly pinsByCid: boolean;
  upload(path: string, cid: string, signal: AbortSignal): Promise<UploadedPin>;
  check?(
    cid: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<RemotePinState>;
  unpin(cid: string, ref: string, signal: AbortSignal): Promise<void>;
}

export const PIN_PROVIDERS = Symbol('PIN_PROVIDERS');

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly status: number,
    body: string,
  ) {
    super(`${provider} responded ${status}: ${body.slice(0, 300)}`);
  }
}
