import "../env.d.ts";
import type { QueueMessage } from "@clipfeed/shared/types";

// Producer-side test double for env.JOBS — records every message sent
// without touching a real queue. Pair with processQueueMessage (queue.ts)
// or index.ts's `queue` export to simulate the consumer side in a test.
export class FakeQueue implements Queue<QueueMessage> {
  sent: QueueMessage[] = [];

  send(body: QueueMessage): Promise<void> {
    this.sent.push(body);
    return Promise.resolve();
  }
}

// Consumer-side test double for a single message — tracks ack()/retry()
// calls so a test can assert index.ts's `queue` export handled a message
// correctly without a real Cloudflare Queues runtime.
export class FakeMessage implements Message<QueueMessage> {
  readonly id = "fake-message-id";
  readonly timestamp = new Date();
  readonly attempts = 1;
  acked = false;
  retried = false;

  constructor(public readonly body: QueueMessage) {}

  ack(): void {
    this.acked = true;
  }

  retry(): void {
    this.retried = true;
  }
}

export function makeBatch(messages: FakeMessage[]): MessageBatch<QueueMessage> {
  return {
    queue: "clipfeed-jobs",
    messages,
    ackAll(): void {
      for (const m of messages) m.acked = true;
    },
    retryAll(): void {
      for (const m of messages) m.retried = true;
    },
  };
}
