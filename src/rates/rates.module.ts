import { Global, Module } from '@nestjs/common';
import { FixedRatesClient } from './fixed-rates.client.js';
import { RATES_CLIENT } from './rates-client.js';

/** Binds `RATES_CLIENT`. Swap `useValue` for the real client when rates-service is ready. */
@Global()
@Module({
  providers: [{ provide: RATES_CLIENT, useValue: new FixedRatesClient() }],
  exports: [RATES_CLIENT],
})
export class RatesModule {}
