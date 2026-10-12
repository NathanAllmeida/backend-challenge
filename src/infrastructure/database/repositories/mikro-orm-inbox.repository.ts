import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InboxRepository } from '../../../application/ports/repositories';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxMessageEntity } from '../entities/messaging.entity';

@Injectable()
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async register(message: InboxMessage): Promise<boolean> {
    const rows: unknown[] = await this.em.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );

    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageEntity, { consumerName, messageId }, { refresh: true });

    if (!entity) {
      return null;
    }

    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt ?? undefined,
    });
  }

  async save(message: InboxMessage): Promise<void> {
    await this.em.execute(
      'UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?',
      [message.processedAt ?? null, message.consumerName, message.messageId],
    );
  }
}
