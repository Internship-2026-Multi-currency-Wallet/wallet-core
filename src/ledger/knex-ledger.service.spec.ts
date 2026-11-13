import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import { KNEX } from '../database/database.module.js';
import { KnexLedgerService } from './knex-ledger.service.js';
import { InsertOperationResult, LedgerRepository } from './ledger.repository.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type PostOperation,
} from './ledger.types.js';
import { operationFingerprint } from './operation-fingerprint.js';

const FUNDING_ID = randomUUID();
const USER_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const FUNDING_KEY = `platform:${PLATFORM_FUNDING}:UAH`;
const USER_KEY = `user:${USER_ID}:UAH`;

const posting: PostOperation = {
  type: 'test_credit',
  idempotencyKey: 'k1',
  entries: [
    { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
    { account: userAccount(USER_ID, 'UAH'), amount: 100n },
  ],
};

function deadlock(): Error {
  return Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213 });
}

function lockedAccounts() {
  return [
    { id: FUNDING_ID, type: 'platform' as const, balance: 0n, version: 0 },
    { id: ACCOUNT_ID, type: 'user' as const, balance: 0n, version: 0 },
  ];
}

/** The service against a repository whose database calls are stubbed: only its own logic is under test. */
async function setup() {
  const logger = { info: jest.fn(), warn: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      KnexLedgerService,
      LedgerRepository,
      { provide: KNEX, useValue: {} },
      { provide: getLoggerToken(KnexLedgerService.name), useValue: logger },
    ],
  }).compile();
  const repository = moduleRef.get(LedgerRepository);

  jest.spyOn(repository, 'ensureUserAccounts').mockResolvedValue(undefined);
  jest.spyOn(repository, 'findAccountIds').mockResolvedValue(
    new Map([
      [FUNDING_KEY, FUNDING_ID],
      [USER_KEY, ACCOUNT_ID],
    ]),
  );
  jest.spyOn(repository, 'transaction').mockImplementation((work) => work(repository));
  jest.spyOn(repository, 'insertOperation').mockResolvedValue(InsertOperationResult.Created);
  jest.spyOn(repository, 'updateBalance').mockResolvedValue(undefined);
  jest.spyOn(repository, 'insertEntries').mockResolvedValue(undefined);
  jest.spyOn(repository, 'lockAccounts').mockResolvedValue(lockedAccounts());
  return { service: moduleRef.get(KnexLedgerService), repository, logger };
}

describe('KnexLedgerService deadlock retry', () => {
  it('runs the posting again after a deadlock and returns the result of the later attempt', async () => {
    const { service, repository } = await setup();
    jest
      .spyOn(repository, 'lockAccounts')
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce(lockedAccounts());

    const result = await service.post(posting);

    expect(result.replayed).toBe(false);
    expect(repository.lockAccounts).toHaveBeenCalledTimes(3);
    expect(repository.updateBalance).toHaveBeenCalledTimes(2);
    expect(repository.insertEntries).toHaveBeenCalledTimes(1);
  });

  it('warns with the attempt number before each retry', async () => {
    const { service, repository, logger } = await setup();
    jest
      .spyOn(repository, 'lockAccounts')
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce(lockedAccounts());

    await service.post(posting);

    expect(logger.warn.mock.calls.map(([fields]) => fields)).toEqual([
      expect.objectContaining({ attempt: 1, type: 'test_credit' }),
      expect.objectContaining({ attempt: 2, type: 'test_credit' }),
    ]);
  });

  it('gives up with the deadlock error after 3 attempts', async () => {
    const { service, repository } = await setup();
    jest.spyOn(repository, 'lockAccounts').mockRejectedValue(deadlock());

    await expect(service.post(posting)).rejects.toMatchObject({ errno: 1213 });

    expect(repository.lockAccounts).toHaveBeenCalledTimes(3);
  });

  it('rethrows any other error at once, without a second attempt', async () => {
    const { service, repository, logger } = await setup();
    const failure = new Error('connection lost');
    jest.spyOn(repository, 'lockAccounts').mockRejectedValue(failure);

    await expect(service.post(posting)).rejects.toBe(failure);

    expect(repository.lockAccounts).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retries a deadlock while creating the user accounts too', async () => {
    const { service, repository } = await setup();
    const missingUser = new Map([[FUNDING_KEY, FUNDING_ID]]);
    jest
      .spyOn(repository, 'findAccountIds')
      .mockResolvedValueOnce(missingUser)
      .mockResolvedValueOnce(missingUser)
      .mockResolvedValueOnce(new Map([[USER_KEY, ACCOUNT_ID]]));
    jest.spyOn(repository, 'ensureUserAccounts').mockRejectedValueOnce(deadlock());

    const result = await service.post(posting);

    expect(result.replayed).toBe(false);
    expect(repository.ensureUserAccounts).toHaveBeenCalledTimes(2);
  });
});

describe('KnexLedgerService account resolution', () => {
  it('creates no account when every account of the posting exists', async () => {
    const { service, repository } = await setup();

    await service.post(posting);

    expect(repository.findAccountIds).toHaveBeenCalledTimes(1);
    expect(repository.ensureUserAccounts).not.toHaveBeenCalled();
  });

  it('creates only the missing user accounts and looks them up again', async () => {
    const { service, repository } = await setup();
    jest
      .spyOn(repository, 'findAccountIds')
      .mockResolvedValueOnce(new Map([[FUNDING_KEY, FUNDING_ID]]))
      .mockResolvedValueOnce(new Map([[USER_KEY, ACCOUNT_ID]]));

    await service.post(posting);

    expect(repository.ensureUserAccounts).toHaveBeenCalledTimes(1);
    expect(repository.ensureUserAccounts).toHaveBeenCalledWith([
      expect.objectContaining({ userId: USER_ID, currency: 'UAH' }),
    ]);
    expect(repository.findAccountIds).toHaveBeenLastCalledWith([userAccount(USER_ID, 'UAH')]);
  });

  it('never creates a missing platform account and writes nothing', async () => {
    const { service, repository } = await setup();
    jest.spyOn(repository, 'findAccountIds').mockResolvedValue(new Map([[USER_KEY, ACCOUNT_ID]]));

    await expect(service.post(posting)).rejects.toThrow(`Unknown ledger account ${FUNDING_KEY}`);

    expect(repository.ensureUserAccounts).not.toHaveBeenCalled();
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('writes nothing when an account row vanished before it was locked', async () => {
    const { service, repository } = await setup();
    jest
      .spyOn(repository, 'lockAccounts')
      .mockResolvedValue([{ id: FUNDING_ID, type: 'platform', balance: 0n, version: 0 }]);

    await expect(service.post(posting)).rejects.toThrow('disappeared before it was locked');

    expect(repository.insertOperation).not.toHaveBeenCalled();
    expect(repository.updateBalance).not.toHaveBeenCalled();
    expect(repository.insertEntries).not.toHaveBeenCalled();
  });
});

describe('KnexLedgerService getBalances', () => {
  it('only reads: creates no account and answers zero for a missing one', async () => {
    const { service, repository } = await setup();
    jest
      .spyOn(repository, 'readUserBalances')
      .mockResolvedValue([{ currency: 'USD', balance: 7n, version: 3 }]);

    const balances = await service.getBalances(USER_ID);

    expect(balances).toEqual([
      { currency: 'UAH', amount: 0n, version: 0 },
      { currency: 'USD', amount: 7n, version: 3 },
      { currency: 'EUR', amount: 0n, version: 0 },
      { currency: 'PLN', amount: 0n, version: 0 },
      { currency: 'USDT', amount: 0n, version: 0 },
    ]);
    expect(repository.ensureUserAccounts).not.toHaveBeenCalled();
    expect(repository.transaction).not.toHaveBeenCalled();
  });
});

describe('KnexLedgerService logging', () => {
  it('logs a posted operation by id and type only', async () => {
    const { service, logger } = await setup();

    const result = await service.post(posting);

    expect(logger.info).toHaveBeenCalledWith(
      { operationId: result.operation.id, type: 'test_credit', replayed: false },
      'ledger operation posted',
    );
  });

  it('logs an answered replay as replayed', async () => {
    const { service, repository, logger } = await setup();
    const operationId = randomUUID();
    jest.spyOn(repository, 'insertOperation').mockResolvedValue(InsertOperationResult.KeyTaken);
    jest.spyOn(repository, 'findOperationByKey').mockResolvedValue({
      id: operationId,
      type: 'test_credit',
      fingerprint: operationFingerprint(posting),
      createdAt: new Date(),
      entries: [],
    });

    await service.post(posting);

    expect(logger.info).toHaveBeenCalledWith(
      { operationId, type: 'test_credit', replayed: true },
      'ledger operation replayed',
    );
  });
});
