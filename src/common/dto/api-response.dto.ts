export class ApiResponseDto<T = unknown> {
  readonly success!: boolean;
  readonly statusCode!: number;
  readonly path!: string;
  readonly timestamp!: string;
  readonly data?: T;
  readonly message?: string | string[];

  private constructor(partial: ApiResponseDto<T>) {
    Object.assign(this, partial);
  }

  static success<T>(
    data: T,
    statusCode: number,
    path: string,
  ): ApiResponseDto<T> {
    return new ApiResponseDto({
      success: true,
      statusCode,
      path,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  static error(
    message: string | string[],
    statusCode: number,
    path: string,
  ): ApiResponseDto<never> {
    return new ApiResponseDto({
      success: false,
      statusCode,
      path,
      timestamp: new Date().toISOString(),
      message,
    });
  }
}
