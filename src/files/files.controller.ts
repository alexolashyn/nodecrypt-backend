import {
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/decorators/current-user.decorator';
import { writeJsonLine } from 'src/common/timing/json-log';
import { requestContext, StageTimer } from 'src/common/timing/stage-timer';
import type { TestFault } from 'src/config/env.validation';
import { FileIdParamDto } from './dto/file-id-param.dto';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  private readonly timingLog: boolean;
  private readonly wrongCid: boolean;

  constructor(
    private readonly filesService: FilesService,
    config: ConfigService,
  ) {
    this.timingLog = config.get<boolean>('UPLOAD_TIMING_LOG') ?? false;
    this.wrongCid = (config.get<TestFault[]>('TEST_FAULTS') ?? []).includes(
      'wrong_cid',
    );
  }

  @Post(':fileId')
  public async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param() { fileId }: FileIdParamDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { requestId, requestStart } = requestContext(res);
    const timer = new StageTimer(requestStart);
    timer.since('guards', timer.start);
    let status = 201;
    try {
      const result = await this.filesService.upload(
        owner(user),
        fileId,
        req,
        timer,
      );
      return this.wrongCid
        ? { ...result, cid: corruptCid(result.cid) }
        : result;
    } catch (err) {
      status = err instanceof HttpException ? err.getStatus() : 500;
      throw err;
    } finally {
      if (!req.complete) res.setHeader('Connection', 'close');
      if (this.timingLog)
        writeJsonLine({
          type: 'upload_timing',
          requestId,
          fileId,
          status,
          ...timer.toRecord(),
        });
    }
  }

  @Delete(':fileId')
  public async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param() { fileId }: FileIdParamDto,
  ) {
    return this.filesService.remove(owner(user), fileId);
  }

  @Get(':fileId')
  public async status(
    @CurrentUser() user: AuthenticatedUser,
    @Param() { fileId }: FileIdParamDto,
  ) {
    return this.filesService.status(owner(user), fileId);
  }
}

function owner(user: AuthenticatedUser): string {
  return user.address.toLowerCase();
}

function corruptCid(cid: string): string {
  return cid.slice(0, -1) + (cid.endsWith('a') ? 'b' : 'a');
}
