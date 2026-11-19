import { ConfigService } from '@nestjs/config';
import { createPinProviders } from '../pinning.module';
import { FilebaseProvider } from './filebase.provider';
import { PinataProvider } from './pinata.provider';
import { PsaPinProvider } from './psa.provider';
import { FailingPinProvider, StubPinProvider } from './test-providers';

jest.mock('src/cid/cid.service', () => ({ CID_PROFILE: {} }));

const CID = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am';
const signal = () => new AbortController().signal;

describe('StubPinProvider', () => {
  afterEach(() => jest.useRealTimers());

  it('pins the CID it was given after the configured delay', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const stub = new StubPinProvider('pinata', 300);
    let done = false;

    const pinned = stub.upload('/tmp/x', CID, signal()).then((r) => {
      done = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pinned).resolves.toEqual({
      cid: CID,
      ref: `stub-pinata-${CID}`,
      state: 'pinned',
    });
  });

  it('queues a pin-by-CID stub and confirms it on the first check', async () => {
    const stub = new StubPinProvider('octopin', 0, true);

    const pinned = await stub.upload('/tmp/x', CID, signal());

    expect(pinned.state).toBe('queued');
    await expect(stub.check!(CID, pinned.ref, signal())).resolves.toBe(
      'pinned',
    );
  });

  it('has no status check for an upload stub', () => {
    expect(new StubPinProvider('pinata', 0).check).toBeUndefined();
  });

  it.each([
    [0, 240],
    [0.5, 300],
    [0.999999, 360],
  ])('keeps the delay within ±20%% (random=%d → ~%d ms)', (r, ms) => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(r);
    const setTimer = jest.spyOn(global, 'setTimeout');

    void new StubPinProvider('filebase', 300).unpin(CID, 'ref', signal());

    expect(setTimer.mock.calls[0][1]).toBeCloseTo(ms, 2);
  });

  it('gives up when the provider timeout aborts the call', async () => {
    const stub = new StubPinProvider('pinata', 60_000);

    await expect(
      stub.upload('/tmp/x', CID, AbortSignal.timeout(10)),
    ).rejects.toThrow();
  });
});

describe('createPinProviders', () => {
  const config = (env: Record<string, unknown>) =>
    new ConfigService({
      PINNING_MODE: 'real',
      PINNING_STUB_DELAY_MS: 300,
      TEST_FAULTS: [],
      PINATA_JWT: 'jwt',
      FILEBASE_RPC_TOKEN: 'token',
      OCTOPIN_PSA_URL: 'https://api.octopin.app/psa',
      OCTOPIN_API_KEY: 'key',
      ...env,
    });

  it('builds the real providers by default', () => {
    const providers = createPinProviders(config({}));

    expect(providers[0]).toBeInstanceOf(PinataProvider);
    expect(providers[1]).toBeInstanceOf(FilebaseProvider);
    expect(providers[2]).toBeInstanceOf(PsaPinProvider);
    expect(providers.map((p) => [p.name, p.pinsByCid])).toEqual([
      ['pinata', false],
      ['filebase', false],
      ['octopin', true],
    ]);
  });

  it('builds stubs with the real names in stub mode, without tokens', () => {
    const providers = createPinProviders(
      config({
        PINNING_MODE: 'stub',
        PINATA_JWT: undefined,
        FILEBASE_RPC_TOKEN: undefined,
        OCTOPIN_API_KEY: undefined,
      }),
    );

    expect(providers.map((p) => p.constructor)).toEqual([
      StubPinProvider,
      StubPinProvider,
      StubPinProvider,
    ]);
    expect(providers.map((p) => [p.name, p.pinsByCid])).toEqual([
      ['pinata', false],
      ['filebase', false],
      ['octopin', true],
    ]);
  });

  it('replaces only the providers named in TEST_FAULTS', async () => {
    const [pinata, filebase] = createPinProviders(
      config({ PINNING_MODE: 'stub', TEST_FAULTS: ['fail_pinata'] }),
    );

    expect(pinata).toBeInstanceOf(FailingPinProvider);
    expect(pinata.name).toBe('pinata');
    expect(filebase).toBeInstanceOf(StubPinProvider);
    await expect(pinata.upload('/tmp/x', CID, signal())).rejects.toThrow(
      'pinata is down (TEST_FAULTS)',
    );
    await expect(pinata.unpin(CID, 'ref', signal())).rejects.toThrow();
  });

  it('can fail a real provider too', () => {
    const providers = createPinProviders(
      config({ TEST_FAULTS: ['fail_filebase'] }),
    );

    expect(providers[0]).toBeInstanceOf(PinataProvider);
    expect(providers[1]).toBeInstanceOf(FailingPinProvider);
    expect(providers[2]).toBeInstanceOf(PsaPinProvider);
  });

  it('fails octopin with its pin-by-CID nature intact', async () => {
    const octopin = createPinProviders(
      config({ PINNING_MODE: 'stub', TEST_FAULTS: ['fail_octopin'] }),
    )[2];

    expect(octopin).toBeInstanceOf(FailingPinProvider);
    expect(octopin.pinsByCid).toBe(true);
    await expect(octopin.check!(CID, 'ref', signal())).rejects.toThrow(
      'octopin is down (TEST_FAULTS)',
    );
  });
});
