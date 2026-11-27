/**
 * What a new module's source starts as: a working module over any GraphQL API, since every schema
 * answers introspection. It lists the upstream's object types.
 */
export const EXAMPLE_SOURCE = `// A module is one TSX file over one or more upstreams. Swap this query for one built from the upstream's
// schema (Upstreams, then View schema), and the list for whatever shows its data best. A plain gql document
// goes to the default upstream; one for another of the module's upstreams is written gql.from('<name>')\`…\`.
import { gql, useQuery } from 'symphony';
import { CardLayout } from '@/components/card-layout';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';

const OBJECT_TYPES = gql\`
  query ObjectTypes {
    __schema {
      queryType {
        name
      }
      types {
        name
        kind
        description
      }
    }
  }
\`;

interface ObjectTypesData {
  __schema: {
    queryType: { name: string };
    types: { name: string; kind: string; description: string | null }[];
  };
}

export default function ObjectTypes() {
  const result = useQuery<ObjectTypesData>(OBJECT_TYPES);
  const schema = result.data?.__schema;
  const types = (schema?.types ?? []).filter((type) => type.kind === 'OBJECT' && type.name.startsWith('__') === false);
  return (
    <CardLayout
      title="Object types"
      description={schema === undefined ? undefined : \`Queries start at \${schema.queryType.name}.\`}
      contentSlot={
        <>
          <LoadState query={result} what="the schema" count={types.length} />
          <List
            label="Object types"
            contentSlot={types.map((type) => (
              <ListItem key={type.name} title={type.name} description={type.description ?? undefined} />
            ))}
          />
        </>
      }
    />
  );
}
`;
