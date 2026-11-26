// A small in-process event feed: one service says something changed, others follow it, and neither imports the
// other. Listeners run one after another, in the order they subscribed, so a later one sees what an earlier one did.
import { errorMessage } from './errors.ts';

/** Follows one kind of event. */
export type EventListener<E> = (event: E) => void | Promise<void>;

/** Where one kind of event is announced and followed. */
export interface EventFeed<E> {
  /**
   * Runs every listener on an event, in order. A listener that throws is logged and the rest still run.
   *
   * @param event - What happened.
   */
  emit(event: E): Promise<void>;
  /**
   * Adds a listener.
   *
   * @param listener - Runs on every later event.
   * @returns A function that removes it.
   */
  subscribe(listener: EventListener<E>): () => void;
}

/**
 * Builds an event feed.
 *
 * @typeParam E - The event's type.
 * @param tag - The log tag a failing listener is reported under, such as `[upstreams]`.
 * @returns The feed, with no listeners.
 */
export function createEventFeed<E>(tag: string): EventFeed<E> {
  const listeners = new Set<EventListener<E>>();
  return {
    emit: async (event) => {
      for (const listener of listeners) {
        try {
          await listener(event);
        } catch (error) {
          console.error(tag, `a listener failed: ${errorMessage(error)}`);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
