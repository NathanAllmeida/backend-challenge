import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 100n;
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const money = Money.parse(props);

    if (money.isNegative()) {
      throw new InvalidMoneyError('Amount must not be negative');
    }

    return money;
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const sign = this.cents < 0n ? '-' : '';
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const units = absolute / FACTOR;
    const decimals = (absolute % FACTOR).toString().padStart(SCALE, '0');

    return `${sign}${units}.${decimals}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parse(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid amount "${String(props?.amount)}": expected a decimal string with up to ${SCALE} places`);
    }

    const [units = '0', decimals = ''] = props.amount.replace('-', '').split('.');
    const cents = BigInt(units) * FACTOR + BigInt(decimals.padEnd(SCALE, '0'));
    const signed = props.amount.startsWith('-') ? -cents : cents;

    return new Money(signed, Money.assertCurrency(props.currency));
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected ISO-4217 code`);
    }

    return currency;
  }
}
