import { EntitySchema } from '@mikro-orm/core';

export class InboxMessageEntity {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageEntity>({
  class: InboxMessageEntity,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true },
  },
});

export class OutboxMessageEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  lockedUntil?: Date | null;
  publishedAt?: Date | null;
  lastError?: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageEntity>({
  class: OutboxMessageEntity,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at', nullable: true },
    lockedUntil: { type: 'datetime', columnType: 'timestamptz', fieldName: 'locked_until', nullable: true },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'published_at', nullable: true },
    lastError: { type: 'text', fieldName: 'last_error', nullable: true },
  },
});
