import { Module } from '@nestjs/common';
import { KnexLedgerService } from './knex-ledger.service.js';
import { LedgerRepository } from './ledger.repository.js';
import { LedgerResolver } from './ledger.resolver.js';
import { LedgerService } from './ledger.service.js';

@Module({
  providers: [
    LedgerResolver,
    LedgerRepository,
    { provide: LedgerService, useClass: KnexLedgerService },
  ],
  exports: [LedgerService],
})
export class LedgerModule {}
