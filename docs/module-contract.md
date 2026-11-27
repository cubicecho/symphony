# Writing a Symphony module

A module is **one TSX file** that renders one piece of UI over **one or more upstream GraphQL APIs**
(any mix of stored upstreams and the built-in `unified` one). Symphony checks it, compiles it, and shows
it on pages, where it queries the upstreams through Symphony's proxy. You never see an upstream's address
or its credentials: the runtime sends every document for you.

## The shape

```tsx
import { gql, useQuery } from 'symphony';
import { CardLayout } from '@/components/card-layout';
import { LoadState } from '@/components/load-state';

const RECENT_ORDERS = gql`
  query RecentOrders($first: Int!) {
    orders(first: $first) {
      id
      total
    }
  }
`;

interface RecentOrdersData {
  orders: { id: string; total: number }[];
}

export default function RecentOrders() {
  const orders = useQuery<RecentOrdersData>(RECENT_ORDERS, { variables: { first: 10 } });
  const rows = orders.data?.orders ?? [];
  return (
    <CardLayout
      title="Recent orders"
      contentSlot={
        <>
          <LoadState query={orders} what="the recent orders" count={rows.length} compact />
          <ul>
            {rows.map((order) => (
              <li key={order.id}>{order.total}</li>
            ))}
          </ul>
        </>
      }
    />
  );
}
```

## Rules the compiler enforces

1. **A default export that is a React component.** It receives no props.
2. **Imports come only from this list:**
   - `react`
   - `symphony` (the runtime, below)
   - the cubeui components Symphony has installed, as `@/components/<name>` and `@/components/ui/<name>`
     (`list_components` names them, and `get_component_docs` gives their props)
   - `@/lib/utils` (`cn`, for joining class names)

   Anything else, a relative import or an npm package, is an error.
3. **Every GraphQL document is a `gql` or `gql.from('<upstream>')` tagged template with no `${…}` inside
   it.** Variables go in `variables`, never into the text. Each document must parse and validate against
   its upstream's schema, as Symphony last fetched it. Errors point at the line and column in your file.
4. **A plain `gql` document goes to the module's default upstream**, the first one it lists.
   A document for another of its upstreams is tagged `gql.from('<name>')`, with the upstream's name as a
   string literal, so the compiler knows which schema to check it against. A name the module does not
   list is an error.
5. **TypeScript syntax is allowed but not type-checked yet.** Types are stripped, so a wrong type
   compiles. Read the schema (`get_schema`) for the real field names and types.

## The `symphony` runtime

| Export        | Signature                                                                                                                                                                         | What it does                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gql`         | ``gql`…` → string``, ``gql.from('<upstream>')`…` → document``                                                                                                                     | Marks a GraphQL document so the compiler finds and validates it. `gql` returns the text, for the default upstream; `gql.from` returns a document for the named upstream, which the hooks send there.                 |
| `useQuery`    | `useQuery<T>(document, { variables?, refetchIntervalSeconds?, enabled? }?)` → `{ data: T \| undefined, error: Error \| null, isLoading, isPending, isError: boolean, refetch() }` | Runs a query against the document's upstream. Cached per document and variables. The result can be passed straight to `LoadState`'s `query`, which draws loading and failure and renders nothing once data is there. |
| `useMutation` | `useMutation<T, V>(document)` → `{ mutate(variables?: V): Promise<T>, data: T \| undefined, error: Error \| null, isPending: boolean }`                                           | Runs a mutation against the document's upstream. When it succeeds, every query of this module is fetched again.                                                                                                      |

| `useSubscription` | `useSubscription<T>(document, { variables?, enabled?, maxEvents?, onEvent? }?)` → `{ events: T[], latest: T \| undefined, status, error: Error \| null }` | Follows a subscription on the document's upstream. `events` holds the `data` of the latest `maxEvents` (default 100) events, oldest first; `onEvent(data)` is called as each arrives. `status` is `'idle'` (not enabled), `'connecting'`, `'open'`, `'complete'` or `'error'`. |

An upstream's GraphQL errors arrive as `error`, with the upstream's messages joined.

## Following something live

A `subscription` document goes through `useSubscription`, never `useQuery`. The stream opens when the module
mounts, closes when it unmounts or its variables change, and completes when the upstream completes it.

```tsx
import { gql, useQuery, useSubscription } from 'symphony';

const RUNS = gql`
  query Runs {
    runs {
      id
      status
    }
  }
`;

const EVENTS = gql`
  subscription RunEvents($runId: String!) {
    runEvents(runId: $runId) {
      seq
      kind
      text
    }
  }
`;

interface RunEvent {
  seq: number;
  kind: string;
  text: string;
}

function RunLog({ runId }: { runId: string | null }) {
  const runs = useQuery(RUNS);
  const { events, status, error } = useSubscription<{ runEvents: RunEvent }>(EVENTS, {
    variables: { runId },
    enabled: runId !== null,
    // Fetch the run list again once the run says it is done.
    onEvent: (data) => {
      if (data.runEvents.kind === 'end') {
        runs.refetch();
      }
    },
  });
  // …render events.map((event) => event.runEvents.text), and status
}
```

- **Reconnects.** A dropped stream reconnects with backoff (1 s, doubling up to 30 s) and `status` goes back to
  `'connecting'` with the reason in `error`. One the upstream completed (`'complete'`) or Symphony refused
  (`'error'`, for an invalid document, say) is not tried again.
- **Events are kept across a reconnect.** An upstream that replays what it said so far (like `runEvents`) sends
  those events again after one, so key what you render by a field such as `seq`.
- **An event's GraphQL errors** arrive as `error` without closing the stream.
- **Limits.** Symphony closes a stream that has had no event for a while (5 minutes by default; the module then
  reconnects), refuses one over its stream limits, and ends one whose event is too large.
- **Not through `unified`.** The built-in unified API doesn't stream subscriptions yet: tag the document
  `gql.from('<upstream>')` for the upstream that serves the field.
- **Agents can't subscribe.** `run_query` refuses subscription documents. To see the same data, run the upstream's
  snapshot query, one that returns what happened so far (Task Server's `run_events(runId, afterSeq)`).

### Long-running mutations: start, then subscribe

A query or mutation through the proxy has 30 seconds to answer. A mutation that only answers when a long job
ends (a run, an import) outlasts that. Start the job with a mutation that returns at once, with the job's id,
then follow it with its subscription:

```tsx
const START = gql`mutation Start($task: String!) { startRun(task: $task) { id } }`;

const start = useMutation<{ startRun: { id: string } }>(START);
const [runId, setRunId] = useState<string | null>(null);
const { latest } = useSubscription<{ runEvents: RunEvent }>(EVENTS, { variables: { runId }, enabled: runId !== null });
// onClick: setRunId((await start.mutate({ task })).startRun.id)
```

## More than one upstream

A module lists its upstreams in order when it is submitted (`upstreams: ["orders", "unified"]`). The
first is the default. Here `RECENT_ORDERS` goes to `orders`, and `PEOPLE` to `unified`:

```tsx
import { gql, useQuery } from 'symphony';

const RECENT_ORDERS = gql`
  query RecentOrders {
    orders(first: 5) {
      id
    }
  }
`;

const PEOPLE = gql.from('unified')`
  query People {
    people {
      id
      name
    }
  }
`;
```

## Styling

- Build from cubeui shells first (`CardLayout`, `PropertyList`, `StatTile`, `Table`, `List`, `ListItem`,
  `LoadState`, `EmptyState`…). **No cubeui component takes `children`**: the body goes in `contentSlot`
  and every other part in a prop ending in `Slot`.
- Colours are tokens (`bg-card`, `text-foreground/60`, `border-border`), never a palette
  (`bg-blue-500`).
- **Known limit:** only Tailwind classes the Symphony app already uses are styled. Prefer the
  components' own props, and plain layout classes (`flex`, `grid`, `gap-2`, `p-4`, `text-sm`).

## Workflow for an agent

1. `list_upstreams`, then `get_schema` (whole, or one `type`) or `search_schema` to find the fields.
2. `run_query` to try a document and see real data before writing the component.
3. `list_components` and `get_component_docs` for the shells you use.
4. `submit_module` with the whole file and its `upstreams`, the default first. Read the errors, fix, and submit again with the same `id`
   until `ok` is true. A person then places it on a page.
