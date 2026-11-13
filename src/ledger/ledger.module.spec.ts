import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from '../config/config.module.js';
import { KNEX } from '../database/database.module.js';
import { KnexLedgerService } from './knex-ledger.service.js';
import { LedgerModule } from './ledger.module.js';
import { LedgerService } from './ledger.service.js';

// The real DatabaseModule opens a connection pool; this test only checks the binding.
@Global()
@Module({ providers: [{ provide: KNEX, useValue: {} }], exports: [KNEX] })
class StubDatabaseModule {}

describe('LedgerModule', () => {
  it('binds KnexLedgerService as LedgerService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        StubDatabaseModule,
        LedgerModule,
      ],
    }).compile();
    expect(moduleRef.get(LedgerService)).toBeInstanceOf(KnexLedgerService);
  });
});
