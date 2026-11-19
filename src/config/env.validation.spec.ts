import { envSchema } from './env.validation';

const ADDRESS = `0x${'1'.repeat(40)}`;

const valid = {
  JWT_SECRET: 'x'.repeat(32),
  REFRESH_TOKEN_TTL_SECONDS: '604800',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'secret',
  NONCE_TTL_SECONDS: '300',
  RATE_LIMIT_WINDOW_SECONDS: '60',
  RATE_LIMIT_MAX_REQUESTS: '100',
  CORS_ORIGIN: 'http://localhost:5173',
  RPC_URL: 'https://rpc.example',
  CHAIN_ID: '11155111',
  FILE_REGISTRY_ADDRESS: ADDRESS,
  STORAGE_TIER_ADDRESS: ADDRESS,
  MAX_UPLOAD_BYTES: '104857600',
  UPLOAD_TMP_DIR: '/tmp/nodecrypt',
  PIN_QUORUM: '2',
  PINATA_JWT: 'pinata',
  FILEBASE_RPC_TOKEN: 'filebase',
  OCTOPIN_API_KEY: 'octopin',
};

const issues = (env: Record<string, unknown>) => {
  const result = envSchema.safeParse(env);
  expect(result.success).toBe(false);
  return [...new Set(result.error!.issues.map((i) => i.path.join('.')))];
};

const PROVIDER_TOKENS = ['PINATA_JWT', 'FILEBASE_RPC_TOKEN', 'OCTOPIN_API_KEY'];

describe('envSchema', () => {
  it('coerces numeric strings and fills defaults', () => {
    const env = envSchema.parse(valid);

    expect(env.CHAIN_ID).toBe(11155111);
    expect(env.PIN_QUORUM).toBe(2);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      JWT_EXPIRES_IN: '1h',
      UPLOAD_REQUEST_TIMEOUT_SECONDS: 1800,
      UPLOAD_IDLE_TIMEOUT_SECONDS: 60,
      UPLOAD_MAX_CONCURRENT_PER_USER: 2,
      UPLOAD_MAX_CONCURRENT_GLOBAL: 10,
      PIN_PROVIDER_TIMEOUT_SECONDS: 600,
      OCTOPIN_PSA_URL: 'https://api.octopin.app/psa',
      PIN_CONFIRM_POLL_MS: 2000,
      PIN_RETRY_INTERVAL_MS: 30_000,
      PIN_RETRY_MAX_ATTEMPTS: 5,
    });
  });

  it('names every missing required variable', () => {
    const required = Object.keys(valid).filter(
      (k) => !PROVIDER_TOKENS.includes(k),
    );

    expect(issues({})).toEqual(expect.arrayContaining(required));
  });

  it.each([
    ['JWT_SECRET', 'too-short'],
    ['REDIS_URL', 'not a url'],
    ['NODE_ENV', 'staging'],
    ['FILE_REGISTRY_ADDRESS', '0x1234'],
    ['STORAGE_TIER_ADDRESS', `0x${'g'.repeat(40)}`],
    ['NONCE_TTL_SECONDS', '0'],
    ['RATE_LIMIT_MAX_REQUESTS', '-5'],
    ['CHAIN_ID', '1.5'],
    ['UPLOAD_TMP_DIR', ''],
    ['PINATA_JWT', ''],
    ['OCTOPIN_API_KEY', ''],
    ['OCTOPIN_PSA_URL', 'not a url'],
    ['PIN_RETRY_MAX_ATTEMPTS', '0'],
  ])('rejects an invalid %s', (key, value) => {
    expect(issues({ ...valid, [key]: value })).toEqual([key]);
  });

  it.each(['0', '4'])(
    'rejects PIN_QUORUM=%s, since three providers exist',
    (quorum) => {
      expect(issues({ ...valid, PIN_QUORUM: quorum })).toEqual(['PIN_QUORUM']);
    },
  );

  it('accepts a quorum of all three providers', () => {
    expect(envSchema.parse({ ...valid, PIN_QUORUM: '3' }).PIN_QUORUM).toBe(3);
  });

  describe('test mode', () => {
    const withoutTokens = Object.fromEntries(
      Object.entries(valid).filter(([k]) => !PROVIDER_TOKENS.includes(k)),
    );

    it('is fully off by default', () => {
      expect(envSchema.parse(valid)).toMatchObject({
        PINNING_MODE: 'real',
        PINNING_STUB_DELAY_MS: 300,
        TEST_FAULTS: [],
        UPLOAD_TIMING_LOG: false,
        REDIS_TIMING_LOG: false,
      });
    });

    it('requires all three provider tokens for real pinning', () => {
      expect(issues(withoutTokens)).toEqual(PROVIDER_TOKENS);
    });

    it('needs no provider tokens for stub pinning', () => {
      expect(() =>
        envSchema.parse({ ...withoutTokens, PINNING_MODE: 'stub' }),
      ).not.toThrow();
    });

    it('parses TEST_FAULTS into a list and the log switches into booleans', () => {
      expect(
        envSchema.parse({
          ...valid,
          TEST_FAULTS: ' wrong_cid, fail_pinata, fail_octopin ',
          UPLOAD_TIMING_LOG: '1',
          REDIS_TIMING_LOG: 'true',
        }),
      ).toMatchObject({
        TEST_FAULTS: ['wrong_cid', 'fail_pinata', 'fail_octopin'],
        UPLOAD_TIMING_LOG: true,
        REDIS_TIMING_LOG: true,
      });
    });

    it('rejects an unknown fault', () => {
      expect(issues({ ...valid, TEST_FAULTS: 'fail_everything' })).toEqual([
        'TEST_FAULTS.0',
      ]);
    });

    it.each([
      ['PINNING_MODE', 'stub'],
      ['TEST_FAULTS', 'fail_pinata'],
    ])('refuses %s=%s in production', (key, value) => {
      expect(
        issues({ ...valid, NODE_ENV: 'production', [key]: value }),
      ).toEqual([key]);
    });
  });
});
