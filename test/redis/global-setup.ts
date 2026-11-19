import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

const PASSWORD = 'nodecrypt-test';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export default async function globalSetup() {
  const port = await freePort();
  const server = spawn(
    'redis-server',
    [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--requirepass',
      PASSWORD,
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('redis-server did not start within 10 s')),
      10_000,
    );
    server.once('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot run redis-server (brew install redis): ${err.message}`,
        ),
      );
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`redis-server exited early with code ${code}`));
    });
    server.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Ready to accept connections')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  process.env.TEST_REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.TEST_REDIS_PASSWORD = PASSWORD;
  (globalThis as { redisServer?: ChildProcess }).redisServer = server;
}
