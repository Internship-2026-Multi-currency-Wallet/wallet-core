import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from '../config/config.module.js';
import { KNEX } from '../database/database.module.js';
import { EventPublisher } from '../events/event-bus.js';
import { KnexLedgerService } from './knex-ledger.service.js';
import { LedgerModule } from './ledger.module.js';
import { LedgerService } from './ledger.service.js';

// The real DatabaseModule opens a connection pool; this test only checks the binding.
@Global()
@Module({ providers: [{ provide: KNEX, useValue: {} }], exports: [KNEX] })
class StubDatabaseModule {}

// The real EventsModule connects to Redis.
@Global()
@Module({ providers: [{ provide: EventPublisher, useValue: {} }], exports: [EventPublisher] })
class StubEventsModule {}

describe('LedgerModule', () => {
  it('binds KnexLedgerService as LedgerService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        StubDatabaseModule,
        StubEventsModule,
        LedgerModule,
      ],
    }).compile();
    expect(moduleRef.get(LedgerService)).toBeInstanceOf(KnexLedgerService);
  });
});
