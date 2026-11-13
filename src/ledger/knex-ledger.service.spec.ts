import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { KNEX } from '../database/database.module.js';
import { KnexLedgerService } from './knex-ledger.service.js';
import { InsertOperationResult, LedgerRepository } from './ledger.repository.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type PostOperation,
} from './ledger.types.js';

const FUNDING_ID = randomUUID();
const USER_ID = randomUUID();
const ACCOUNT_ID = randomUUID();

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

/** The service against a repository whose database calls are stubbed: only the retry is under test. */
async function setup(): Promise<{ service: KnexLedgerService; repository: LedgerRepository }> {
  const moduleRef = await Test.createTestingModule({
    providers: [KnexLedgerService, LedgerRepository, { provide: KNEX, useValue: {} }],
  }).compile();
  const repository = moduleRef.get(LedgerRepository);

  jest.spyOn(repository, 'ensureUserAccounts').mockResolvedValue(undefined);
  jest.spyOn(repository, 'findAccountIds').mockResolvedValue(
    new Map([
      [`platform:${PLATFORM_FUNDING}:UAH`, FUNDING_ID],
      [`user:${USER_ID}:UAH`, ACCOUNT_ID],
    ]),
  );
  jest.spyOn(repository, 'transaction').mockImplementation((work) => work(repository));
  jest.spyOn(repository, 'insertOperation').mockResolvedValue(InsertOperationResult.Created);
  jest.spyOn(repository, 'updateBalance').mockResolvedValue(undefined);
  jest.spyOn(repository, 'insertEntries').mockResolvedValue(undefined);
  jest.spyOn(repository, 'lockAccounts').mockResolvedValue([
    { id: FUNDING_ID, type: 'platform', balance: 0n },
    { id: ACCOUNT_ID, type: 'user', balance: 0n },
  ]);
  return { service: moduleRef.get(KnexLedgerService), repository };
}

describe('KnexLedgerService deadlock retry', () => {
  it('runs the posting again after a deadlock and returns the result of the later attempt', async () => {
    const { service, repository } = await setup();
    jest
      .spyOn(repository, 'lockAccounts')
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce([
        { id: FUNDING_ID, type: 'platform', balance: 0n },
        { id: ACCOUNT_ID, type: 'user', balance: 0n },
      ]);

    const result = await service.post(posting);

    expect(result.replayed).toBe(false);
    expect(repository.lockAccounts).toHaveBeenCalledTimes(3);
    expect(repository.updateBalance).toHaveBeenCalledTimes(2);
    expect(repository.insertEntries).toHaveBeenCalledTimes(1);
  });

  it('gives up with the deadlock error after 3 attempts', async () => {
    const { service, repository } = await setup();
    jest.spyOn(repository, 'lockAccounts').mockRejectedValue(deadlock());

    await expect(service.post(posting)).rejects.toMatchObject({ errno: 1213 });

    expect(repository.lockAccounts).toHaveBeenCalledTimes(3);
  });

  it('rethrows any other error at once, without a second attempt', async () => {
    const { service, repository } = await setup();
    const failure = new Error('connection lost');
    jest.spyOn(repository, 'lockAccounts').mockRejectedValue(failure);

    await expect(service.post(posting)).rejects.toBe(failure);

    expect(repository.lockAccounts).toHaveBeenCalledTimes(1);
  });

  it('retries a deadlock while creating the user accounts too', async () => {
    const { service, repository } = await setup();
    jest.spyOn(repository, 'ensureUserAccounts').mockRejectedValueOnce(deadlock());

    const result = await service.post(posting);

    expect(result.replayed).toBe(false);
    expect(repository.ensureUserAccounts).toHaveBeenCalledTimes(2);
  });
});
