import { z } from 'zod';

const evmAddress = /^0x[0-9a-fA-F]{40}$/;

export const TEST_FAULTS = [
  'wrong_cid',
  'fail_pinata',
  'fail_filebase',
  'fail_octopin',
] as const;
export type TestFault = (typeof TEST_FAULTS)[number];

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().default(3000),
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().default('1h'),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().positive(),
    REDIS_URL: z.url(),
    REDIS_PASSWORD: z.string(),
    NONCE_TTL_SECONDS: z.coerce.number().positive(),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().positive(),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().positive(),
    CORS_ORIGIN: z.string(),

    RPC_URL: z.url(),
    CHAIN_ID: z.coerce.number().int().positive(),
    FILE_REGISTRY_ADDRESS: z.string().regex(evmAddress),
    STORAGE_TIER_ADDRESS: z.string().regex(evmAddress),

    MAX_UPLOAD_BYTES: z.coerce.number().int().positive(),
    UPLOAD_TMP_DIR: z.string().min(1),
    UPLOAD_REQUEST_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(1800),
    UPLOAD_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
    UPLOAD_MAX_CONCURRENT_PER_USER: z.coerce
      .number()
      .int()
      .positive()
      .default(2),
    UPLOAD_MAX_CONCURRENT_GLOBAL: z.coerce
      .number()
      .int()
      .positive()
      .default(10),

    PIN_QUORUM: z.coerce.number().int().min(1).max(3),
    PIN_PROVIDER_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    PINATA_JWT: z.string().min(1).optional(),
    FILEBASE_RPC_TOKEN: z.string().min(1).optional(),
    OCTOPIN_PSA_URL: z.url().default('https://api.octopin.app/psa'),
    OCTOPIN_API_KEY: z.string().min(1).optional(),
    PIN_CONFIRM_POLL_MS: z.coerce.number().int().positive().default(2000),
    PIN_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    PIN_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

    PINNING_MODE: z.enum(['real', 'stub']).default('real'),
    PINNING_STUB_DELAY_MS: z.coerce.number().int().nonnegative().default(300),
    TEST_FAULTS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(TEST_FAULTS))),
    UPLOAD_TIMING_LOG: z.stringbool().default(false),
    REDIS_TIMING_LOG: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    if (env.PINNING_MODE === 'real') {
      for (const key of [
        'PINATA_JWT',
        'FILEBASE_RPC_TOKEN',
        'OCTOPIN_API_KEY',
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when PINNING_MODE=real`,
          });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.PINNING_MODE === 'stub')
        ctx.addIssue({
          code: 'custom',
          path: ['PINNING_MODE'],
          message: 'Stub pinning stores nothing and is refused in production',
        });
      if (env.TEST_FAULTS.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: ['TEST_FAULTS'],
          message: 'Fault injection is refused in production',
        });
    }
  });
export type Env = z.infer<typeof envSchema>;
