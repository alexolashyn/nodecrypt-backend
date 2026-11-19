import { Module } from '@nestjs/common';
import { ChainModule } from 'src/chain/chain.module';
import { CidModule } from 'src/cid/cid.module';
import { PinningModule } from 'src/pinning/pinning.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { UploadGate } from './upload-gate.service';

@Module({
  imports: [ChainModule, CidModule, PinningModule],
  controllers: [FilesController],
  providers: [FilesService, UploadGate],
})
export class FilesModule {}
