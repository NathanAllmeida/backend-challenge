import { v7 as uuidv7 } from 'uuid';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../errors/domain.error';
import { Money } from '../money/money';
import { LedgerDirection, oppositeDirection } from '../wallet/ledger-direction';
import { FailureCode } from './failure-code';
import { ReferenceRetryPolicy } from './reference-retry-policy';
import { ALLOWED_REFERENCE_KINDS, REVERSAL_KINDS, WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  id: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
  updatedAt: Date;
}

export const INTERNAL_PROVIDER_ID = 'internal';

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceAttempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _nextReferenceCheckAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING transactions are internal and cannot be submitted');
    }

    const transaction = WagerTransaction.build(props);

    if (transaction.requiresReference() && !transaction.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${transaction.kind} requires referenceExternalTransactionId`);
    }

    if (transaction.referenceExternalTransactionId === transaction.externalTransactionId) {
      throw new InvalidWagerTransactionError('A transaction cannot reference itself');
    }

    if (transaction.kind !== WagerTransactionKind.Loss && !transaction.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${transaction.kind} amount must be greater than zero`);
    }

    return transaction;
  }

  static opening(props: { walletId: string; playerId: string; money: Money; payloadHash: string; at: Date }): WagerTransaction {
    return WagerTransaction.build({
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'wallet',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.updatedAt,
      state.referenceAttempts,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal();

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  markPendingReference(at: Date, observedBalance: Money): void {
    this.assertNotTerminal();

    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = ReferenceRetryPolicy.nextAttemptAt(this._referenceAttempts, at);
    this._observedBalance = observedBalance;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal();

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal();

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  isTerminal(): boolean {
    return (TERMINAL_STATUSES as readonly WagerTransactionStatus[]).includes(this._status);
  }

  isProcessed(): boolean {
    return this._status === WagerTransactionStatus.Processed;
  }

  isAwaitingReference(): boolean {
    return this._status === WagerTransactionStatus.Pending || this._status === WagerTransactionStatus.PendingReference;
  }

  hasExhaustedReferenceAttempts(): boolean {
    return ReferenceRetryPolicy.isExhausted(this._referenceAttempts);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (REVERSAL_KINDS as readonly WagerTransactionKind[]).includes(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  canReference(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind) ?? false;
  }

  belongsToSameRoundAs(reference: WagerTransaction): boolean {
    return reference.providerId === this.providerId
      && reference.playerId === this.playerId
      && reference.walletId === this.walletId
      && reference.roundId === this.roundId
      && reference.money.currency === this.money.currency;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK direction depends on the referenced transaction');
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not move balance');
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} is already ${this._status}`);
    }
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      uuidv7(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      props.createdAt,
      0,
    );
  }
}
