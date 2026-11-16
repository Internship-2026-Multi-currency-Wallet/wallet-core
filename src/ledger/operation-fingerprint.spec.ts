import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type PostOperation,
} from './ledger.types.js';
import { operationFingerprint } from './operation-fingerprint.js';

const base: PostOperation = {
  type: 'test_credit',
  idempotencyKey: 'k1',
  entries: [
    { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
    { account: userAccount('user-1', 'UAH'), amount: 100n },
  ],
};

describe('operationFingerprint', () => {
  it('is a sha256 hex string', () => {
    expect(operationFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on entry order or on the idempotency key', () => {
    const reordered: PostOperation = {
      ...base,
      idempotencyKey: 'another-key',
      entries: [...base.entries].reverse(),
    };
    expect(operationFingerprint(reordered)).toBe(operationFingerprint(base));
  });

  it('changes with the amount', () => {
    const other: PostOperation = {
      ...base,
      entries: [
        { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -101n },
        { account: userAccount('user-1', 'UAH'), amount: 101n },
      ],
    };
    expect(operationFingerprint(other)).not.toBe(operationFingerprint(base));
  });

  it('changes with the operation type', () => {
    // OperationType has a single member for now; the cast stands in for a second one.
    const other = { ...base, type: 'transfer' } as unknown as PostOperation;
    expect(operationFingerprint(other)).not.toBe(operationFingerprint(base));
  });

  it('changes with the account', () => {
    const other: PostOperation = {
      ...base,
      entries: [
        { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
        { account: userAccount('user-2', 'UAH'), amount: 100n },
      ],
    };
    expect(operationFingerprint(other)).not.toBe(operationFingerprint(base));
  });
});
