import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

export class FileIdParamDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @Matches(/^0x[0-9a-f]{64}$/, {
    message: 'fileId must be a 0x-prefixed bytes32 hex string',
  })
  fileId!: string;
}
