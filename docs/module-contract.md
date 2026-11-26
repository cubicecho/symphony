# Writing a Symphony module

A module is **one TSX file** that renders one piece of UI over **one upstream GraphQL API**. Symphony
checks it, compiles it, and shows it on pages, where it queries the upstream through Symphony's proxy.
You never see the upstream's address or its credentials: the runtime sends every document for you.

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
3. **Every GraphQL document is a `gql` tagged template with no `${…}` inside it.** Variables go in
   `variables`, never into the text. Each document must parse and validate against the upstream's schema,
   as Symphony last fetched it. Errors point at the line and column in your file.
4. **TypeScript syntax is allowed but not type-checked yet.** Types are stripped, so a wrong type
   compiles. Read the schema (`get_schema`) for the real field names and types.

## The `symphony` runtime

| Export        | Signature                                                                                                                                                                         | What it does                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gql`         | ``gql`…` → string``                                                                                                                                                               | Marks a GraphQL document so the compiler finds and validates it. Returns the text.                                                                                                                                 |
| `useQuery`    | `useQuery<T>(document, { variables?, refetchIntervalSeconds?, enabled? }?)` → `{ data: T \| undefined, error: Error \| null, isLoading, isPending, isError: boolean, refetch() }` | Runs a query against the module's upstream. Cached per document and variables. The result can be passed straight to `LoadState`'s `query`, which draws loading and failure and renders nothing once data is there. |
| `useMutation` | `useMutation<T, V>(document)` → `{ mutate(variables?: V): Promise<T>, data: T \| undefined, error: Error \| null, isPending: boolean }`                                           | Runs a mutation. When it succeeds, every query of this module is fetched again.                                                                                                                                    |

An upstream's GraphQL errors arrive as `error`, with the upstream's messages joined.

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
4. `submit_module` with the whole file. Read the errors, fix, and submit again with the same `id`
   until `ok` is true. A person then places it on a page.
