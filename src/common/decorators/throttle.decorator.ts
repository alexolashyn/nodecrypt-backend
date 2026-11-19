import { SetMetadata } from '@nestjs/common';

export interface ThrottleOptions {
  limit: number;
  windowSeconds: number;
}

export const THROTTLE_KEY = 'throttle';
export const SKIP_THROTTLE_KEY = 'skipThrottle';

export const Throttle = (options: Partial<ThrottleOptions>) =>
  SetMetadata(THROTTLE_KEY, options);

export const SkipThrottle = () => SetMetadata(SKIP_THROTTLE_KEY, true);
