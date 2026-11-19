import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { VerifyDto } from 'src/auth/dto/verify.dto';
import { FileIdParamDto } from 'src/files/dto/file-id-param.dto';
import { VALIDATION_OPTIONS } from './common.module';

const pipe = new ValidationPipe(VALIDATION_OPTIONS);

const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});
const param = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'param',
  metatype,
});

async function messages(value: unknown, meta: ArgumentMetadata) {
  const err: unknown = await pipe
    .transform(value, meta)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).getResponse() as { message: string[] };
}

const FILE_ID = `0x${'ab'.repeat(32)}`;

describe('global validation', () => {
  describe('FileIdParamDto', () => {
    it('hands the handler a lowercased fileId', async () => {
      const result = (await pipe.transform(
        { fileId: FILE_ID.toUpperCase().replace('0X', '0x') },
        param(FileIdParamDto),
      )) as FileIdParamDto;

      expect(result).toBeInstanceOf(FileIdParamDto);
      expect(result.fileId).toBe(FILE_ID);
    });

    it.each([
      ['too short', '0xabc'],
      ['missing 0x', 'ab'.repeat(32)],
      ['not hex', `0x${'zz'.repeat(32)}`],
    ])('rejects a fileId that is %s', async (_, fileId) => {
      const { message } = await messages({ fileId }, param(FileIdParamDto));

      expect(message).toContain(
        'fileId must be a 0x-prefixed bytes32 hex string',
      );
    });
  });

  describe('VerifyDto', () => {
    it('accepts a message and a signature', async () => {
      await expect(
        pipe.transform({ message: 'm', signature: 's' }, body(VerifyDto)),
      ).resolves.toBeInstanceOf(VerifyDto);
    });

    it('rejects unknown fields instead of silently dropping them', async () => {
      const { message } = await messages(
        { message: 'm', signature: 's', isAdmin: true },
        body(VerifyDto),
      );

      expect(message).toContain('property isAdmin should not exist');
    });

    it('rejects empty or missing fields', async () => {
      const { message } = await messages({ message: '' }, body(VerifyDto));

      expect(message).toEqual(
        expect.arrayContaining([
          'message should not be empty',
          'signature should not be empty',
        ]),
      );
    });
  });
});
