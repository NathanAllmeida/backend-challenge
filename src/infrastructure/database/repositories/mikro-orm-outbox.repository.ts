import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { OutboxBacklog, OutboxRepository } from '../../../application/ports/repositories';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../entities/messaging.entity';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  last_error: string | null;
}

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(message: OutboxMessage): Promise<void> {
    this.em.persist(this.em.create(OutboxMessageEntity, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      lockedUntil: null,
      publishedAt: null,
      lastError: null,
    }));
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows: OutboxRow[] = await this.em.execute(
      `UPDATE outbox_messages
          SET locked_until = ?::timestamptz + (? * interval '1 millisecond')
        WHERE id IN (
          SELECT id
            FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (locked_until IS NULL OR locked_until <= ?)
           ORDER BY occurred_at
           LIMIT ?
             FOR UPDATE SKIP LOCKED
        )
      RETURNING id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at, last_error`,
      [now, leaseMs, now, now, limit],
    );

    return rows
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
      .map((row) => OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
        publishedAt: row.published_at ? new Date(row.published_at) : undefined,
        lastError: row.last_error ?? undefined,
      }));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET published_at = ?, next_attempt_at = NULL, locked_until = NULL
        WHERE id = ? AND published_at IS NULL`,
      [message.publishedAt, message.id],
    );
  }

  async scheduleRetry(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, last_error = ?, locked_until = NULL
        WHERE id = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? null, message.lastError?.slice(0, 1000) ?? null, message.id],
    );
  }

  async backlog(): Promise<OutboxBacklog> {
    const [row]: Array<{ pending: string; oldest: Date | null }> = await this.em.execute(
      'SELECT COUNT(*)::text AS pending, MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
    );

    return {
      pending: Number(row?.pending ?? 0),
      oldestOccurredAt: row?.oldest ? new Date(row.oldest) : undefined,
    };
  }
}
