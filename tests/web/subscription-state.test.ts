import {
  callOnEvent,
  createReconnectPlanner,
  FIRST_RECONNECT_DELAY_MS,
  keepLatest,
  MAX_RECONNECT_DELAY_MS,
  maxEventsProblem,
} from '../../web/src/modules/subscription-state.ts';

describe('keepLatest', () => {
  it('keeps the newest events up to the limit', () => {
    expect(keepLatest([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it('keeps none for a limit of 0', () => {
    expect(keepLatest([1, 2], 3, 0)).toEqual([]);
  });
});

describe('maxEventsProblem', () => {
  it('takes a whole number of 0 or more', () => {
    expect(maxEventsProblem(0)).toBeNull();
    expect(maxEventsProblem(50)).toBeNull();
  });

  it('refuses a negative or fractional limit', () => {
    expect(maxEventsProblem(-1)?.message).toMatch(/whole number of 0 or more/);
    expect(maxEventsProblem(1.5)).toBeInstanceOf(Error);
    expect(maxEventsProblem(Number.NaN)).toBeInstanceOf(Error);
  });
});

describe('createReconnectPlanner', () => {
  it('backs off on drops in a row, up to the cap', () => {
    const reconnects = createReconnectPlanner();
    const waits = Array.from({ length: 7 }, () => reconnects.dropped());
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, MAX_RECONNECT_DELAY_MS]);
  });

  it('starts over only once an event has arrived', () => {
    const reconnects = createReconnectPlanner();
    reconnects.dropped();
    reconnects.dropped();
    // A stream that opened and dropped without an event keeps backing off.
    expect(reconnects.dropped()).toBe(4000);
    reconnects.received();
    expect(reconnects.dropped()).toBe(FIRST_RECONNECT_DELAY_MS);
  });
});

describe('callOnEvent', () => {
  it('hands the data to the callback', () => {
    const seen: number[] = [];
    expect(callOnEvent((data: number) => seen.push(data), 7)).toBeNull();
    expect(seen).toEqual([7]);
  });

  it("returns a callback's throw instead of letting it escape", () => {
    const thrown = callOnEvent(() => {
      throw new Error('boom');
    }, 1);
    expect(thrown?.message).toBe("The module's onEvent threw: boom");
  });

  it('does nothing without a callback', () => {
    expect(callOnEvent(undefined, 1)).toBeNull();
  });
});
