import { logger } from '../../common/observability/logger.js';
import { deadLetterQueues, queues, type JobPayload, type QueueName } from '../../jobs/queues.js';
import { claimOutboxEvents, retryOutboxEvent, type OutboxEvent } from './outbox.service.js';

function targetQueues(eventType: string): QueueName[] {
  if (eventType === 'payment.intent.requested') return ['payment-intent'];
  if (eventType === 'refund.requested') return ['payment-refund'];
  if (eventType === 'prescription.issued') return ['prescription-pdf'];
  return [];
}

function eventJobData(event: OutboxEvent): JobPayload {
  return {
    eventId: event.id,
    eventType: event.event_type,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    payload: event.payload,
    traceparent: event.traceparent,
  };
}

async function enqueueEvent(event: OutboxEvent): Promise<void> {
  const targets = targetQueues(event.event_type);
  const payload = eventJobData(event);
  if (targets.length === 0) {
    await deadLetterQueues['outbox-relay'].add(
      'unrouted-event',
      {
        eventId: event.id,
        eventType: event.event_type,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        reason: 'No queue is configured for this event type',
      },
      { jobId: `outbox-${event.id}` },
    );
    return;
  }

  for (const target of targets) {
    await queues[target].add('process', payload, { jobId: `outbox-${event.id}` });
  }
}

export async function relayOutboxBatch(): Promise<number> {
  const events = await claimOutboxEvents();
  for (const event of events) {
    try {
      await enqueueEvent(event);
    } catch (error) {
      try {
        await retryOutboxEvent(event);
      } catch (retryError) {
        logger.error(
          {
            eventId: event.id,
            errorType: retryError instanceof Error ? retryError.name : 'unknown',
          },
          'Unable to reschedule outbox event',
        );
      }
      logger.error(
        {
          eventId: event.id,
          eventType: event.event_type,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Outbox event could not be enqueued',
      );
    }
  }
  return events.length;
}
