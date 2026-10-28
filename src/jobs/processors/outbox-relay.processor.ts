import { relayOutboxBatch } from '../../modules/outbox/outbox.relay.js';

export async function processOutboxRelay(): Promise<number> {
  return relayOutboxBatch();
}
