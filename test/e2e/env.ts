import { tmpdir } from 'node:os';
import { join } from 'node:path';

const redisUrl = process.env.TEST_REDIS_URL;
const redisPassword = process.env.TEST_REDIS_PASSWORD;
if (!redisUrl?.startsWith('redis://127.0.0.1:') || !redisPassword)
  throw new Error('No local test Redis; run through npm run test:e2e');

const ADDRESS = `0x${'1'.repeat(40)}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '0',
  JWT_SECRET: 'e2e-secret-'.padEnd(32, 'x'),
  JWT_EXPIRES_IN: '1h',
  REFRESH_TOKEN_TTL_SECONDS: '3600',
  REDIS_URL: redisUrl,
  REDIS_PASSWORD: redisPassword,
  NONCE_TTL_SECONDS: '300',
  RATE_LIMIT_WINDOW_SECONDS: '60',
  RATE_LIMIT_MAX_REQUESTS: '5',
  CORS_ORIGIN: 'http://localhost:5173',
  RPC_URL: 'http://127.0.0.1:1',
  CHAIN_ID: '11155111',
  FILE_REGISTRY_ADDRESS: ADDRESS,
  STORAGE_TIER_ADDRESS: ADDRESS,
  MAX_UPLOAD_BYTES: '1048576',
  UPLOAD_TMP_DIR: join(tmpdir(), `nodecrypt-e2e-${process.pid}`),
  UPLOAD_REQUEST_TIMEOUT_SECONDS: '60',
  UPLOAD_IDLE_TIMEOUT_SECONDS: '10',
  UPLOAD_MAX_CONCURRENT_PER_USER: '2',
  UPLOAD_MAX_CONCURRENT_GLOBAL: '10',
  PIN_QUORUM: '2',
  PIN_PROVIDER_TIMEOUT_SECONDS: '10',
  PINATA_JWT: 'unused-in-e2e',
  FILEBASE_RPC_TOKEN: 'unused-in-e2e',
  OCTOPIN_API_KEY: 'unused-in-e2e',
  PIN_CONFIRM_POLL_MS: '20',
  PIN_RETRY_INTERVAL_MS: '60000',
});
