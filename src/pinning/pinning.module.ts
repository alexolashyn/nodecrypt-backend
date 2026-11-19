import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TestFault } from 'src/config/env.validation';
import { PinningService } from './pinning.service';
import { PinRetryWorker } from './pin-retry.worker';
import { PinStateRepository } from './pin-state.repository';
import { PIN_PROVIDERS, PinProvider } from './providers/pin-provider';
import { PinataProvider } from './providers/pinata.provider';
import { FilebaseProvider } from './providers/filebase.provider';
import { PsaPinProvider } from './providers/psa.provider';
import {
  FailingPinProvider,
  StubPinProvider,
} from './providers/test-providers';

export function createPinProviders(config: ConfigService): PinProvider[] {
  const stubDelay = () => config.getOrThrow<number>('PINNING_STUB_DELAY_MS');
  const providers: PinProvider[] =
    config.getOrThrow<'real' | 'stub'>('PINNING_MODE') === 'stub'
      ? [
          new StubPinProvider('pinata', stubDelay()),
          new StubPinProvider('filebase', stubDelay()),
          new StubPinProvider('octopin', stubDelay(), true),
        ]
      : [
          new PinataProvider(config),
          new FilebaseProvider(config),
          new PsaPinProvider(
            'octopin',
            config.getOrThrow<string>('OCTOPIN_PSA_URL'),
            config.getOrThrow<string>('OCTOPIN_API_KEY'),
          ),
        ];

  const faults = config.getOrThrow<TestFault[]>('TEST_FAULTS');
  return providers.map((p) =>
    faults.includes(`fail_${p.name}`) ? new FailingPinProvider(p) : p,
  );
}

@Module({
  providers: [
    {
      provide: PIN_PROVIDERS,
      inject: [ConfigService],
      useFactory: createPinProviders,
    },
    PinStateRepository,
    PinningService,
    PinRetryWorker,
  ],
  exports: [PinningService, PinStateRepository, PinRetryWorker],
})
export class PinningModule {}
