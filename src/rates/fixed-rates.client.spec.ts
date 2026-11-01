import { Test } from '@nestjs/testing';
import { CURRENCIES } from '../common/currency.js';
import { FixedRatesClient } from './fixed-rates.client.js';
import { RATES_CLIENT, type RatesClient } from './rates-client.js';
import { RatesModule } from './rates.module.js';

describe('FixedRatesClient', () => {
  const asOf = new Date('2026-01-01T00:00:00Z');
  const client = new FixedRatesClient(() => asOf);

  it('returns fixed rates against USD', async () => {
    await expect(client.getRate('USD', 'UAH')).resolves.toEqual({
      base: 'USD',
      quote: 'UAH',
      mid: '41.50000000',
      source: 'fixed',
      asOf,
    });
    expect((await client.getRate('USD', 'USDT')).mid).toBe('1.00000000');
  });

  it('computes cross rates through USD with exact decimals', async () => {
    expect((await client.getRate('EUR', 'UAH')).mid).toBe('45.10869565');
    expect((await client.getRate('UAH', 'PLN')).mid).toBe('0.09518072');
  });

  it('has a rate of 1 for every currency against itself', async () => {
    for (const currency of CURRENCIES) {
      expect((await client.getRate(currency, currency)).mid).toBe('1.00000000');
    }
  });

  it('is bound as the default RATES_CLIENT', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RatesModule] }).compile();
    const bound = moduleRef.get<RatesClient>(RATES_CLIENT);
    expect(bound).toBeInstanceOf(FixedRatesClient);
  });
});
