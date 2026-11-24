import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface MultipartFile {
  field: string;
  path: string;
  filename: string;
}

export interface HttpResult {
  ok: boolean;
  status: number;
  text: string;
}

export async function postMultipartFile(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  file: MultipartFile,
  signal: AbortSignal,
): Promise<HttpResult> {
  const boundary = `----nodecrypt-${randomUUID()}`;
  const head = Buffer.from(
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join('') +
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const { size } = await stat(file.path);

  const req = request(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(head.length + size + tail.length),
    },
    signal,
  });

  const response = new Promise<HttpResult>((resolve, reject) => {
    req.once('error', reject);
    req.once('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
  });

  const body = Readable.from(
    (async function* () {
      yield head;
      yield* createReadStream(file.path);
      yield tail;
    })(),
  );
  const sent = pipeline(body, req).catch(() => undefined);

  const [result] = await Promise.all([response, sent]);
  return result;
}
