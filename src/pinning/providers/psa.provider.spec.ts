import { ProviderHttpError } from './pin-provider';
import { PsaPinProvider } from './psa.provider';

const CID = 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am';
const signal = () => new AbortController().signal;

const pinStatus = (status: string, cid = CID) => ({
  requestid: 'req-1',
  status,
  created: '2026-11-19T13:11:52.467Z',
  pin: { cid, name: cid },
  delegates: [],
});

function respond(status: number, body: unknown) {
  return jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );
}

describe('PsaPinProvider', () => {
  const psa = new PsaPinProvider('octopin', 'https://psa.example/psa/', 'key');

  afterEach(() => jest.restoreAllMocks());

  it('pins by CID only and reports the request id with its state', async () => {
    const fetch = respond(202, pinStatus('queued'));

    await expect(psa.upload('/tmp/ignored', CID, signal())).resolves.toEqual({
      cid: CID,
      ref: 'req-1',
      state: 'queued',
    });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://psa.example/psa/pins');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer key',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(init!.body as string)).toEqual({ cid: CID, name: CID });
  });

  it('reports the CID the service actually accepted', async () => {
    respond(202, pinStatus('queued', 'bafyother'));

    await expect(psa.upload('', CID, signal())).resolves.toMatchObject({
      cid: 'bafyother',
    });
  });

  it.each(['queued', 'pinning', 'pinned', 'failed'])(
    'reads the %s state of a request',
    async (state) => {
      const fetch = respond(200, pinStatus(state));

      await expect(psa.check(CID, 'req-1', signal())).resolves.toBe(state);
      expect(fetch.mock.calls[0][0]).toBe('https://psa.example/psa/pins/req-1');
    },
  );

  it('treats a request the service no longer knows as failed', async () => {
    respond(404, { error: { reason: 'NOT_FOUND' } });

    await expect(psa.check(CID, 'req-1', signal())).resolves.toBe('failed');
  });

  it('rejects a malformed pin status', async () => {
    respond(200, { requestid: 'req-1', status: 'done', pin: { cid: CID } });

    await expect(psa.check(CID, 'req-1', signal())).rejects.toThrow(
      'invalid pin status',
    );
  });

  it('surfaces HTTP errors with the provider name', async () => {
    respond(401, { error: { reason: 'UNAUTHORIZED' } });

    const err = await psa.upload('', CID, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).toMatchObject({ provider: 'octopin', status: 401 });
  });

  it.each([202, 404])('unpins by request id (HTTP %d)', async (status) => {
    const fetch = respond(status, '');

    await expect(psa.unpin(CID, 'req/1', signal())).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe('https://psa.example/psa/pins/req%2F1');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('fails an unpin the service refuses', async () => {
    respond(500, 'boom');

    await expect(psa.unpin(CID, 'req-1', signal())).rejects.toThrow(
      'octopin responded 500: boom',
    );
  });
});
