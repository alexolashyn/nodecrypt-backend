import type { ChildProcess } from 'node:child_process';

export default function globalTeardown() {
  (globalThis as { redisServer?: ChildProcess }).redisServer?.kill();
}
