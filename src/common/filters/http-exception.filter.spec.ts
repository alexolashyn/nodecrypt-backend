import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function host(url = '/auth/verify') {
  const response = {
    status: jest.fn<unknown, [number]>(),
    json: jest.fn<unknown, [Record<string, unknown>]>(),
  };
  response.status.mockReturnValue(response);
  const argumentsHost = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;
  return { argumentsHost, response };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => logError.mockRestore());

  const send = (exception: unknown) => {
    const { argumentsHost, response } = host();
    filter.catch(exception, argumentsHost);
    return {
      status: response.status.mock.calls[0][0],
      body: response.json.mock.calls[0][0],
    };
  };

  it('wraps an HttpException in the error envelope', () => {
    const { status, body } = send(
      new UnauthorizedException('Nonce is invalid'),
    );

    expect(status).toBe(401);
    expect(body).toEqual({
      success: false,
      statusCode: 401,
      path: '/auth/verify',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      message: 'Nonce is invalid',
    });
  });

  it('keeps every validation message as an array', () => {
    const { body } = send(
      new BadRequestException(['fileId must be hex', 'extra should not exist']),
    );

    expect(body.message).toEqual([
      'fileId must be hex',
      'extra should not exist',
    ]);
  });

  it('passes a plain-string response body through with its status', () => {
    const { status, body } = send(
      new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS),
    );

    expect(status).toBe(429);
    expect(body.message).toBe('Too many requests');
  });

  it('falls back to the exception message for an object body without one', () => {
    const { body } = send(new HttpException({ code: 'x' }, 418));

    expect(body.message).toBe('Http Exception');
  });

  it('hides an unknown error behind a generic 500 and logs it', () => {
    const error = new Error('connect ECONNREFUSED redis.internal:6379');

    const { status, body } = send(error);

    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(logError).toHaveBeenCalledWith(error);
  });

  it('logs a 5xx HttpException too', () => {
    const error = new HttpException('Pinning failed', HttpStatus.BAD_GATEWAY);

    expect(send(error).status).toBe(502);
    expect(logError).toHaveBeenCalledWith(error);
  });

  it('does not log client errors', () => {
    send(new BadRequestException('bad'));

    expect(logError).not.toHaveBeenCalled();
  });
});
