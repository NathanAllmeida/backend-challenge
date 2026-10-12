import { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishFailure {
  messageId: string;
  error: string;
}

export abstract class EventPublisher {
  abstract publish(messages: OutboxMessage[]): Promise<PublishFailure[]>;
}
