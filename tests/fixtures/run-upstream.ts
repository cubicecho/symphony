// A small API with a subscription, standing in for Task Server: `runEvents` replays a run's events and completes, or
// stays open after them when the run is still going. Its yoga serves the subscription over SSE, as Task Server's does.
import { createSchema, createYoga, Repeater } from 'graphql-yoga';

/** The fixture's SDL. */
export const RUN_FIXTURE_SDL = /* GraphQL */ `
  "One thing a run said."
  type RunEvent {
    seq: Int!
    kind: String!
    text: String!
  }

  type Query {
    "What a run has said so far: the snapshot form of runEvents."
    runEvents(runId: String!, afterSeq: Int = 0): [RunEvent!]!
  }

  type Subscription {
    "Sends a run's first count events, then completes, or stays open after them when isRunning is true."
    runEvents(runId: String!, count: Int = 3, isRunning: Boolean = false, textBytes: Int = 0): RunEvent!
  }
`;

/** The URL tests register the fixture under; its fetch answers it whatever the host. */
export const RUN_FIXTURE_URL = 'http://runs.test/graphql';

/** One run event. */
interface RunEvent {
  seq: number;
  kind: string;
  text: string;
}

/** The subscription's arguments. */
interface RunEventsArgs {
  runId: string;
  count: number;
  isRunning: boolean;
  /** Pads each event's text to this many bytes, to try the event size limit. */
  textBytes: number;
}

/**
 * Makes a run's events.
 *
 * @param args - The run, how many, and how long each text is.
 * @returns The events, oldest first.
 */
function eventsOf(args: Pick<RunEventsArgs, 'runId' | 'count' | 'textBytes'>): RunEvent[] {
  return Array.from({ length: args.count }, (_, index) => ({
    seq: index + 1,
    kind: 'log',
    text: `${args.runId} step ${index + 1}`.padEnd(args.textBytes, '.'),
  }));
}

/** The fixture, and what it tells tests about the streams it serves. */
export interface RunFixture {
  /** A `fetch` that answers from the fixture without a network. */
  fetch: typeof fetch;
  /** How many runEvents streams are open now. */
  openStreams: () => number;
  /** Resolves once no runEvents stream is open. */
  allClosed: () => Promise<void>;
}

/**
 * Builds the run fixture.
 *
 * @returns Its fetch, and the count of open streams.
 */
export function createRunFixture(): RunFixture {
  let open = 0;
  let onAllClosed: Array<() => void> = [];
  const closed = () => {
    open -= 1;
    if (open === 0) {
      for (const resolve of onAllClosed) {
        resolve();
      }
      onAllClosed = [];
    }
  };
  const schema = createSchema({
    typeDefs: RUN_FIXTURE_SDL,
    resolvers: {
      Query: {
        runEvents: (_: unknown, args: { runId: string; afterSeq: number }) =>
          eventsOf({ runId: args.runId, count: 3, textBytes: 0 }).filter((event) => event.seq > args.afterSeq),
      },
      Subscription: {
        runEvents: {
          subscribe: (_: unknown, args: RunEventsArgs) =>
            new Repeater<RunEvent>(async (push, stop) => {
              open += 1;
              for (const event of eventsOf(args)) {
                await push(event);
              }
              if (args.isRunning === false) {
                stop();
              }
              await stop;
              closed();
            }),
          resolve: (event: RunEvent) => event,
        },
      },
    },
  });
  const yoga = createYoga({ schema, graphqlEndpoint: '/graphql', logging: false });
  return {
    fetch: (input, init) => Promise.resolve(yoga.fetch(new Request(input, init))),
    openStreams: () => open,
    allClosed: () => (open === 0 ? Promise.resolve() : new Promise((resolve) => onAllClosed.push(resolve))),
  };
}
