import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiResponseDto } from '../dto/api-response.dto';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const statusCode: number =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (statusCode >= 500) {
      this.logger.error(exception);
    }

    response
      .status(statusCode)
      .json(
        ApiResponseDto.error(
          this.extractMessage(exception),
          statusCode,
          request.url,
        ),
      );
  }

  private extractMessage(exception: unknown): string | string[] {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') return body;
      if (
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        (typeof body.message === 'string' || Array.isArray(body.message))
      ) {
        return (body as { message: string | string[] }).message;
      }
      return exception.message;
    }

    return 'Internal server error';
  }
}
