import { randomUUID } from 'node:crypto';
import { describeLedgerContract } from '../../test/ledger-contract.js';
import { FakeLedgerService } from './fake-ledger.service.js';

describeLedgerContract({
  name: 'FakeLedgerService',
  createService: () => new FakeLedgerService(),
  newUserId: () => randomUUID(),
});
