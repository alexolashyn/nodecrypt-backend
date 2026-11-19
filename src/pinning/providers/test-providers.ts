import {
  PinProvider,
  ProviderName,
  RemotePinState,
  UploadedPin,
} from './pin-provider';

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

export class StubPinProvider implements PinProvider {
  readonly check?: PinProvider['check'];

  constructor(
    readonly name: ProviderName,
    private readonly delayMs: number,
    readonly pinsByCid = false,
  ) {
    if (pinsByCid)
      this.check = async (_cid, _ref, signal): Promise<RemotePinState> => {
        await delay(this.jittered(), signal);
        return 'pinned';
      };
  }

  async upload(
    _path: string,
    cid: string,
    signal: AbortSignal,
  ): Promise<UploadedPin> {
    await delay(this.jittered(), signal);
    return {
      cid,
      ref: `stub-${this.name}-${cid}`,
      state: this.pinsByCid ? 'queued' : 'pinned',
    };
  }

  async unpin(_cid: string, _ref: string, signal: AbortSignal): Promise<void> {
    await delay(this.jittered(), signal);
  }

  private jittered(): number {
    return this.delayMs * (0.8 + Math.random() * 0.4);
  }
}

export class FailingPinProvider implements PinProvider {
  readonly name: ProviderName;
  readonly pinsByCid: boolean;
  readonly check?: PinProvider['check'];

  constructor(inner: PinProvider) {
    this.name = inner.name;
    this.pinsByCid = inner.pinsByCid;
    if (inner.check) this.check = () => this.down();
  }

  upload(): Promise<UploadedPin> {
    return this.down();
  }

  unpin(): Promise<void> {
    return this.down();
  }

  private down(): Promise<never> {
    return Promise.reject(new Error(`${this.name} is down (TEST_FAULTS)`));
  }
}
