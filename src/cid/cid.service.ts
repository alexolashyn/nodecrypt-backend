import { Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { CID } from 'multiformats/cid';

export const CID_PROFILE = {
  cidVersion: 1,
  rawLeaves: true,
  chunkSize: 262_144,
  maxChildrenPerNode: 174,
} as const;

const discardBlocks = { put: (cid: CID) => cid };

@Injectable()
export class CidService {
  async computeCid(path: string): Promise<CID> {
    let root: CID | undefined;
    for await (const entry of importer(
      [{ content: createReadStream(path) }],
      discardBlocks,
      {
        cidVersion: CID_PROFILE.cidVersion,
        rawLeaves: CID_PROFILE.rawLeaves,
        reduceSingleLeafToSelf: true,
        chunker: fixedSize({ chunkSize: CID_PROFILE.chunkSize }),
        layout: balanced({
          maxChildrenPerNode: CID_PROFILE.maxChildrenPerNode,
        }),
      },
    )) {
      root = entry.cid;
    }
    if (!root) throw new Error(`Importer produced no CID for ${path}`);
    return root;
  }

  decode(bytes: Uint8Array): CID | null {
    try {
      return CID.decode(bytes);
    } catch {
      return null;
    }
  }

  parse(cid: string): CID {
    return CID.parse(cid);
  }
}
