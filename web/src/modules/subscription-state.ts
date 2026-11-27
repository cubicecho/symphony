// The parts of `useSubscription` that need no React: how many events it keeps, when it reconnects, and how a
// module's callback is kept from breaking the stream.

/** How many events `useSubscription` keeps when `maxEvents` is left out. */
export const DEFAULT_MAX_EVENTS = 100;
/** The wait before reconnecting a dropped subscription the first time, in milliseconds. */
export const FIRST_RECONNECT_DELAY_MS = 1000;
/** The longest wait between two reconnects, in milliseconds. */
export const MAX_RECONNECT_DELAY_MS = 30_000;
/** How much the wait grows after each drop in a row. */
const RECONNECT_BACKOFF_FACTOR = 2;

/**
 * Checks a `maxEvents` option.
 *
 * @param maxEvents - What the module passed.
 * @returns Why it is unusable, or null for a whole number of zero or more.
 */
export function maxEventsProblem(maxEvents: number): Error | null {
  const isUsable = Number.isInteger(maxEvents) && maxEvents >= 0;
  return isUsable ? null : new Error(`maxEvents must be a whole number of 0 or more, got ${maxEvents}.`);
}

/**
 * Adds an event to the ones kept, dropping the oldest past the limit.
 *
 * @typeParam T - An event's data.
 * @param events - The events kept so far, oldest first.
 * @param data - The new event's data.
 * @param maxEvents - How many to keep; 0 keeps none.
 * @returns The events to keep.
 */
export function keepLatest<T>(events: readonly T[], data: T, maxEvents: number): T[] {
  // `slice(-0)` would keep everything.
  return maxEvents === 0 ? [] : [...events, data].slice(-maxEvents);
}

/** When to reconnect a subscription that dropped. */
export interface ReconnectPlanner {
  /** An event arrived: the stream works, so the next drop waits the shortest time again. */
  received(): void;
  /**
   * The stream dropped.
   *
   * @returns How long to wait before reconnecting, in milliseconds.
   */
  dropped(): number;
}

/**
 * Plans reconnects with backoff. Only an event resets the wait, not a stream that opens: one that opens and drops at
 * once would otherwise reconnect every second forever.
 *
 * @returns A fresh planner, for one subscription.
 */
export function createReconnectPlanner(): ReconnectPlanner {
  let delayMs = FIRST_RECONNECT_DELAY_MS;
  return {
    received: () => {
      delayMs = FIRST_RECONNECT_DELAY_MS;
    },
    dropped: () => {
      const wait = delayMs;
      delayMs = Math.min(delayMs * RECONNECT_BACKOFF_FACTOR, MAX_RECONNECT_DELAY_MS);
      return wait;
    },
  };
}

/**
 * Calls a module's `onEvent`, so a throw in it neither drops nor reconnects the stream.
 *
 * @typeParam T - An event's data.
 * @param onEvent - The module's callback, if it gave one.
 * @param data - The event's data.
 * @returns The error it threw, named as the callback's, or null.
 */
export function callOnEvent<T>(onEvent: ((data: T) => void) | undefined, data: T): Error | null {
  try {
    onEvent?.(data);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`The module's onEvent threw: ${message}`, { cause: error });
  }
}
