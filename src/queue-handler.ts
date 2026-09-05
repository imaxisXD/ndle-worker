import { consumeClicks } from "./click-delivery";
import { consumeFailedClicks } from "./failed-clicks";
import type { Bindings } from "./types";

export async function consumeQueue(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	if (batch.queue === env.CLICK_EVENTS_QUEUE_NAME)
		return consumeClicks(batch, env);
	if (batch.queue === env.CLICK_EVENTS_FAILED_QUEUE_NAME)
		return consumeFailedClicks(batch, env);
	// Returning from an unhandled queue would acknowledge the entire batch.
	throw new Error("This Worker does not handle the supplied queue");
}
