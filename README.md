# NodeCrypt Backend

NodeCrypt is an end-to-end encrypted file storage dApp: files are encrypted in the browser, registered on-chain, and stored on IPFS. This NestJS backend never sees plaintext or keys — it authenticates wallets with SIWE, checks that uploaded bytes match their on-chain record, and pins them to Filebase, Pinata and Octopin.

## Setup and run

Requirements: Node.js 22.12+, Redis 6.2+ (local or Redis Cloud), an RPC endpoint, the `FileRegistry` and `StorageTier` contracts from `nodecrypt-dapp`, and Filebase, Pinata and Octopin credentials.

```bash
npm ci
cp .env.example .env    # fill in secrets, RPC URL and contract addresses
npm run start:dev       # development, with reload
npm run build && npm run start:prod
```

Every variable is validated at startup by [src/config/env.validation.ts](src/config/env.validation.ts), and the server also refuses to start if the RPC is on the wrong chain or a contract is missing. For local experiments without pinning accounts, set `PINNING_MODE=stub`.

## About the project

**Upload flow.** The client encrypts the file, computes its CID and calls `addFile` on-chain, then sends the bytes to `POST /files/:fileId`. The backend reads the record, streams the body to disk, recomputes the CID and pins only if it matches. Size, CID and ownership always come from the chain, never from the request.

**Pinning.** An upload succeeds once `PIN_QUORUM` providers (2 of 3 by default) hold the file. Filebase and Pinata receive the bytes; Octopin pins by CID through the IPFS Pinning Service API and is finished by a background worker with retries. Identical content is stored once and released only when the last record using it is removed on-chain.

**API.**

| Route | Purpose |
|---|---|
| `GET /auth/nonce`, `POST /auth/verify` | SIWE login; returns an access token and sets a refresh cookie |
| `POST /auth/refresh`, `POST /auth/logout` | Rotate or revoke the session |
| `POST /files/:fileId` | Upload the encrypted container (raw body) |
| `GET /files/:fileId` | Pin status on each provider |
| `DELETE /files/:fileId` | Release the pin after `removeFile` on-chain |
| `GET /health` | `200` while Redis answers |

Every response uses one envelope: `{ success, statusCode, path, timestamp, data | message }`. All routes except auth and health require `Authorization: Bearer <token>`.

**Security.** Single-use nonces, short-lived JWTs with rotating `HttpOnly` refresh cookies, a global auth guard, a per-IP rate limit, concurrent upload slots, byte-exact size checks and timeouts. Internal errors never reach the client.

**Test mode** (off by default, refused in production): `PINNING_MODE=stub`, `TEST_FAULTS=fail_pinata,fail_filebase,fail_octopin,wrong_cid`, and `UPLOAD_TIMING_LOG` / `REDIS_TIMING_LOG` for per-stage JSON timings.

## Tests

| Command | Covers | Needs |
|---|---|---|
| `npm test` | Unit tests, everything mocked | — |
| `npm run test:redis` | Lua scripts, locks, rate limit, upload slots and pin state on a real Redis | `redis-server` |
| `npm run test:e2e` | The whole app over HTTP: login, upload, dedup, removal, rate limit, test mode | `redis-server` |
| `npm run test:cid` | CID reference vectors the frontend must reproduce | — |

The Redis and e2e suites start their own `redis-server` on a random local port (`brew install redis`) and never read `.env` or touch a remote Redis; e2e fakes the chain and the pinning providers.
