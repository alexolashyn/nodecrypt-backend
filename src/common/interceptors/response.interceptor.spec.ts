import { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

function context(statusCode = 200) {
  const response = { statusCode };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ url: '/files/0xabc' }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { ctx, response };
}

const handler = <T>(source: CallHandler<T>['handle']) => ({ handle: source });

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor();

  it('wraps the handler result in the success envelope', async () => {
    const { ctx } = context();

    const result = await lastValueFrom(
      interceptor.intercept(
        ctx,
        handler(() => of({ cid: 'bafy' })),
      ),
    );

    expect(result).toEqual({
      success: true,
      statusCode: 200,
      path: '/files/0xabc',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      data: { cid: 'bafy' },
    });
  });

  it('reports the status as it stands after the handler ran', async () => {
    const { ctx, response } = context(200);
    const source = defer(() => {
      response.statusCode = 201;
      return of('created');
    });

    const result = await lastValueFrom(
      interceptor.intercept(
        ctx,
        handler(() => source),
      ),
    );

    expect(result.statusCode).toBe(201);
  });

  it('lets errors through unwrapped for the exception filter', async () => {
    const { ctx } = context();
    const error = new Error('boom');

    await expect(
      lastValueFrom(
        interceptor.intercept(
          ctx,
          handler(() => throwError(() => error)),
        ),
      ),
    ).rejects.toBe(error);
  });
});
