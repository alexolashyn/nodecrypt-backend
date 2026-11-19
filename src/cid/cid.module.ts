import { Module } from '@nestjs/common';
import { CidService } from './cid.service';

@Module({
  providers: [CidService],
  exports: [CidService],
})
export class CidModule {}
