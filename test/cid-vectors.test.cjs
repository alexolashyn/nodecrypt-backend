const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CidService, CID_PROFILE } = require('../dist/cid/cid.service');

const service = new CidService();
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cid-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cidOf(bytes) {
  const path = join(dir, `${bytes.length}-${Math.random()}`);
  await writeFile(path, bytes);
  return (await service.computeCid(path)).toString();
}

test('single-chunk file hashes to a raw-leaf CID (matches kubo --cid-version=1 --raw-leaves)', async () => {
  assert.equal(
    await cidOf(Buffer.from('hello\n')),
    'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am',
  );
});

test('a file one byte over a chunk gets a dag-pb root', async () => {
  const cid = await cidOf(Buffer.alloc(CID_PROFILE.chunkSize + 1));
  assert.ok(cid.startsWith('bafybei'), cid);
});

test('past maxChildrenPerNode chunks the tree gains a level and stays deterministic', async () => {
  const size = CID_PROFILE.chunkSize * (CID_PROFILE.maxChildrenPerNode + 1);
  const a = await cidOf(Buffer.alloc(size));
  assert.equal(a, await cidOf(Buffer.alloc(size)));
  assert.notEqual(a, await cidOf(Buffer.alloc(size - 1)));
});

test('decode round-trips CID bytes and rejects garbage', () => {
  const cid = service.parse(
    'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am',
  );
  assert.ok(service.decode(cid.bytes).equals(cid));
  assert.equal(service.decode(new Uint8Array([1, 2, 3])), null);
});
