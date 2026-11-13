import { MAX_AMOUNT, parsePositiveAmount } from './money.js';

describe('parsePositiveAmount', () => {
  it.each([
    ['1', 1n],
    ['10050', 10050n],
    [MAX_AMOUNT.toString(), MAX_AMOUNT],
  ])('reads "%s" as %s', (text, expected) => {
    expect(parsePositiveAmount(text)).toBe(expected);
  });

  it.each([
    '',
    '0',
    '-1',
    '+1',
    '01',
    '1.5',
    '1,5',
    '1e3',
    ' 1',
    '1 ',
    '0x10',
    '١٢', // non-ASCII digits
    (MAX_AMOUNT + 1n).toString(),
  ])('refuses "%s"', (text) => {
    expect(parsePositiveAmount(text)).toBeNull();
  });
});
