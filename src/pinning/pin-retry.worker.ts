import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinStateRepository, RetryEntry } from './pin-state.repository';
import { PinningService } from './pinning.service';

const BATCH = 20;

@Injectable()
export class PinRetryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PinRetryWorker.name);
  private readonly intervalMs: number;
  private interval?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    private readonly pinning: PinningService,
    private readonly state: PinStateRepository,
    config: ConfigService,
  ) {
    this.intervalMs = config.get<number>('PIN_RETRY_INTERVAL_MS') ?? 30_000;
  }

  onApplicationBootstrap() {
    this.interval = setInterval(() => void this.tick(), this.intervalMs);
    this.interval.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.interval);
    await this.running;
  }

  tick(): Promise<number> {
    this.running ??= this.drain().finally(() => (this.running = undefined));
    return this.running;
  }

  private async drain(): Promise<number> {
    let due: RetryEntry[];
    try {
      due = await this.state.dueRetries(Date.now(), BATCH);
    } catch (err) {
      this.logger.error(`Could not read the pin retry queue: ${err}`);
      return 0;
    }
    for (const entry of due) {
      try {
        await this.pinning.followUp(entry);
      } catch (err) {
        this.logger.error(
          `Follow-up of ${entry.provider} for ${entry.cid} failed: ${err}`,
        );
      }
    }
    return due.length;
  }
}
