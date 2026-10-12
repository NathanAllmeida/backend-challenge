import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/errors/domain.error';
import { Money } from '@/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it('serializes with a fixed scale of two decimals', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(brl('1000.00').toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  it('adds and subtracts without floating point drift', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('20.00').subtract(brl('80.00')).toString()).toBe('-60.00');
  });

  it('handles values far beyond Number.MAX_SAFE_INTEGER', () => {
    const big = brl('90071992547409919.99');
    expect(big.add(brl('0.01')).toString()).toBe('90071992547409920.00');
  });

  it('is immutable', () => {
    const original = brl('10.00');
    original.add(brl('5.00'));
    original.negate();
    expect(original.toString()).toBe('10.00');
  });

  it('negates and exposes sign helpers', () => {
    const negative = brl('10.00').negate();
    expect(negative.toString()).toBe('-10.00');
    expect(negative.isNegative()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  it('compares values', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80').equals(brl('80.00'))).toBe(true);
    expect(brl('80.00').equals(Money.from({ amount: '80.00', currency: 'USD' }))).toBe(false);
  });

  it.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e5'],
    ['1E-2'],
    [''],
    [' '],
    ['10.001'],
    ['10.'],
    ['.50'],
    ['1,00'],
    ['+10.00'],
    ['0x10'],
    [' 10.00'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejects amounts that are not strings', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('never rounds: more than two decimal places is rejected, not truncated', () => {
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
    expect(() => brl('19.999')).toThrow(InvalidMoneyError);
  });

  it('rejects negative values on input contracts', () => {
    expect(() => brl('-1.00')).toThrow(InvalidMoneyError);
  });

  it('rejects invalid currency codes', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidMoneyError);
    expect(() => Money.zero('')).toThrow(InvalidMoneyError);
  });

  it('refuses to operate across currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
