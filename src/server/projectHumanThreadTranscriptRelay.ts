import { ProjectHumanThreadRelay } from './projectHumanThreadRelay.js';
import type { ProjectHumanThreadTranscriptStore } from './projectHumanThreadTranscriptStore.js';

export class ProjectHumanThreadTranscriptRelayCoordinator {
  readonly #store: ProjectHumanThreadTranscriptStore;
  readonly #relay: ProjectHumanThreadRelay;

  constructor(store: ProjectHumanThreadTranscriptStore, relay: ProjectHumanThreadRelay) {
    this.#store = store;
    this.#relay = relay;
  }

  async retryResponses(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const entry of this.#store.pendingResponseOutbox()) {
      try {
        this.#relay.enqueueResponse(entry.response);
        // The transcript outbox event is `response:${responseId}`, while the
        // relay outbox is keyed by the response record identity itself. Keep
        // the two durable identities distinct and deliver the one we just
        // enqueued; using entry.eventId makes every response miss the relay
        // row and retry forever.
        const result = await this.#relay.deliver(entry.response.responseId);
        if (result.state !== 'delivered') throw new Error('Project human thread response receipt is incomplete.');
        this.#store.markResponseOutboxDelivered(entry.eventId);
        delivered += 1;
      } catch {
        failed += 1;
      }
    }
    return { delivered, failed };
  }
}
