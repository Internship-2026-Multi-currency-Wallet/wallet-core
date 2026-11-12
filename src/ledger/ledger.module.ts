import { Module } from '@nestjs/common';
import { FakeLedgerService } from './fake-ledger.service.js';
import { LedgerService } from './ledger.service.js';

@Module({
  // The fake stays bound until the Knex implementation lands.
  providers: [{ provide: LedgerService, useClass: FakeLedgerService }],
  exports: [LedgerService],
})
export class LedgerModule {}
