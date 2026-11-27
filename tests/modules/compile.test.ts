import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { MODULE_DEFAULTS } from '../../server/core/defaults.ts';
import { RUNTIME_IMPORTS } from '../../server/modules/allowlist.ts';
import { compileModule } from '../../server/modules/compile.ts';
import { type CompileResult, CompileStage } from '../../server/modules/compile-result.ts';
import { MEMO_SDL } from '../fixtures/memo-upstream.ts';
import { FIXTURE_SDL } from '../fixtures/upstream.ts';

const schema = buildSchema(FIXTURE_SDL);
const memoSchema = buildSchema(MEMO_SDL);
/** The default upstream's name in these tests, and a second one's. */
const SHOP = 'shop';
const MEMOS = 'memos';
const allowedImports = new Set<string>([...RUNTIME_IMPORTS, '@/components/card-layout', '@/components/ui/button']);

const VALID = `import { gql, useQuery } from 'symphony';
import { CardLayout } from '@/components/card-layout';

const RECENT_ORDERS = gql\`
  query RecentOrders($first: Int!) {
    orders(first: $first) {
      id
      total
    }
  }
\`;

interface RecentOrdersData {
  orders: { id: string; total: number }[];
}

export default function RecentOrders() {
  const { data } = useQuery<RecentOrdersData>(RECENT_ORDERS, { variables: { first: 10 } });
  return <CardLayout title="Recent orders" contentSlot={<ul>{data?.orders.map((order) => <li key={order.id}>{order.total}</li>)}</ul>} />;
}
`;

/**
 * Compiles a source against the fixture schema.
 *
 * @param source - The TSX.
 * @param withSchema - False to compile as if the schema was never fetched.
 * @returns The result.
 */
function compile(source: string, withSchema = true): Promise<CompileResult> {
  const upstreams = [{ name: SHOP, schema: withSchema ? schema : null }];
  return compileModule({ source, fileName: 'test-module', upstreams, allowedImports });
}

/**
 * Compiles a source over two upstreams: the fixture shop (the default) and the memos.
 *
 * @param source - The TSX.
 * @returns The result.
 */
function compileTwo(source: string): Promise<CompileResult> {
  const upstreams = [
    { name: SHOP, schema },
    { name: MEMOS, schema: memoSchema },
  ];
  return compileModule({ source, fileName: 'test-module', upstreams, allowedImports });
}

/** A module reading the shop by default and the memos through `gql.from`. */
const TWO_UPSTREAMS = `import { gql, useQuery } from 'symphony';

const ORDERS = gql\`
  query Orders {
    orders(first: 1) {
      id
    }
  }
\`;

const MEMO_LIST = gql.from('memos')\`
  query Memos {
    memos {
      id
      title
    }
  }
\`;

export default function Both() {
  useQuery(ORDERS);
  useQuery(MEMO_LIST);
  return null;
}
`;

describe('compileModule', () => {
  it('compiles a valid module and lists its documents', async () => {
    const result = await compile(VALID);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toContain('query RecentOrders');
    expect(result.compiled).toContain('sourceURL=symphony-module/test-module.js');
  });

  it('produces CommonJS whose default export is a function', async () => {
    const result = await compile(VALID);
    const required: string[] = [];
    const fakeRequire = (specifier: string) => {
      required.push(specifier);
      return {
        gql: (strings: TemplateStringsArray) => strings.join(''),
        useQuery: () => ({}),
        jsx: () => null,
        jsxs: () => null,
      };
    };
    const module: { exports: Record<string, unknown> } = { exports: {} };
    new Function('require', 'module', 'exports', result.compiled ?? '')(fakeRequire, module, module.exports);
    expect(typeof module.exports.default).toBe('function');
    expect(required).toEqual(expect.arrayContaining(['symphony', '@/components/card-layout', 'react/jsx-runtime']));
  });

  it('rejects an import outside the list, and says what is allowed', async () => {
    const result = await compile(
      `import _ from 'lodash';\nimport { x } from '@/components/nope';\nexport default function A() { return null; }`,
    );
    expect(result.ok).toBe(false);
    expect(result.compiled).toBeNull();
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatchObject({ stage: CompileStage.Imports, line: 1, column: 15 });
    expect(result.errors[0]?.message).toContain('"lodash"');
    expect(result.errors[0]?.message).toContain('list_components');
    expect(result.errors[1]).toMatchObject({ stage: CompileStage.Imports, line: 2 });
    expect(result.errors[1]?.message).toContain('@/components/nope');
  });

  it('rejects a relative import and an export-from', async () => {
    const result = await compile(
      `import { a } from './helpers';\nexport { b } from 'other';\nexport default function A() { return null; }`,
    );
    expect(result.errors.map((error) => [error.stage, error.line])).toEqual([
      [CompileStage.Imports, 1],
      [CompileStage.Imports, 2],
    ]);
    expect(result.errors[0]?.message).toContain('Relative import "./helpers"');
  });

  it('rejects dynamic import, require and import.meta', async () => {
    const source = `export default function A() {\n  import('react');\n  require('react');\n  return import.meta.url;\n}`;
    const result = await compile(source);
    expect(result.errors.map((error) => [error.stage, error.line])).toEqual([
      [CompileStage.Imports, 2],
      [CompileStage.Imports, 3],
      [CompileStage.Imports, 4],
    ]);
    expect(result.errors[0]?.message).toContain('Dynamic import()');
  });

  it('rejects a module without a default export', async () => {
    const result = await compile(`export function A() { return null; }`);
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Source, line: null })]);
    expect(result.errors[0]?.message).toContain('default export');
  });

  it('accepts `export { X as default }`', async () => {
    const result = await compile(`function A() { return null; }\nexport { A as default };`);
    expect(result.ok).toBe(true);
  });

  it('places a syntax error at its line and skips the later stages', async () => {
    const result = await compile(`import _ from 'lodash';\nexport default function A() {\n  return <div>;\n}\n`);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ stage: CompileStage.Source, line: 4 });
    expect(result.errors[0]?.message).not.toMatch(/\(\d+:\d+\)/);
  });

  it('rejects a source over the size limit', async () => {
    const result = await compile('x'.repeat(MODULE_DEFAULTS.maxSourceChars + 1));
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Source })]);
  });

  it('rejects ${} inside a gql document', async () => {
    const source =
      "import { gql } from 'symphony';\nconst id = 'o1';\nconst Q = gql`query { order(id: ${id}) { id } }`;\nexport default function A() { return null; }";
    const result = await compile(source);
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 3, column: 35 })]);
    expect(result.errors[0]?.message).toContain('variables');
  });

  it('places an invalid field at its line and column in the TSX', async () => {
    const source = VALID.replace('      total\n', '      totl\n');
    const result = await compile(source);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ stage: CompileStage.Graphql, line: 8, column: 7 });
    expect(result.errors[0]?.message).toContain('"totl"');
    expect(result.errors[0]?.message).toContain('query RecentOrders');
  });

  it('maps a position on the template first line by the backtick column', async () => {
    const source =
      "import { gql } from 'symphony';\nconst Q = gql`query { nope }`;\nexport default function A() { return null; }";
    const result = await compile(source);
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 2, column: 23 })]);
  });

  it('only parses documents when there is no schema', async () => {
    const invalidField = await compile(VALID.replace('      total\n', '      totl\n'), false);
    expect(invalidField.ok).toBe(true);
    const syntax = await compile(VALID.replace('      total\n', '      total {\n'), false);
    expect(syntax.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql })]);
    expect(syntax.errors[0]?.message).toContain('Syntax Error');
  });

  it('follows an aliased gql import and a namespace import', async () => {
    const aliased =
      "import { gql as g } from 'symphony';\nconst Q = g`query { nope }`;\nexport default function A() { return null; }";
    const namespaced =
      "import * as runtime from 'symphony';\nconst Q = runtime.gql`query { nope }`;\nexport default function A() { return null; }";
    for (const source of [aliased, namespaced]) {
      const result = await compile(source);
      expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 2 })]);
      expect(result.documents).toEqual(['query { nope }']);
    }
  });

  it('ignores a gql tag not imported from symphony', async () => {
    const source =
      'const gql = (s: TemplateStringsArray) => s.join("");\nconst Q = gql`query { nope }`;\nexport default function A() { return null; }';
    const result = await compile(source);
    expect(result.ok).toBe(true);
    expect(result.documents).toEqual([]);
  });

  it('rejects more documents than the limit', async () => {
    const documents = Array.from(
      { length: MODULE_DEFAULTS.maxDocuments + 1 },
      (_, index) => `const Q${index} = gql\`{ customers { id } }\`;`,
    );
    const source = `import { gql } from 'symphony';\n${documents.join('\n')}\nexport default function A() { return null; }`;
    const result = await compile(source);
    expect(result.errors).toEqual([
      expect.objectContaining({ stage: CompileStage.Graphql, line: MODULE_DEFAULTS.maxDocuments + 2 }),
    ]);
  });
});

describe('compileModule over several upstreams', () => {
  it('checks each document against its own upstream', async () => {
    const result = await compileTwo(TWO_UPSTREAMS);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.documents).toHaveLength(2);
  });

  it('checks a plain gql document against the default upstream only', async () => {
    const result = await compileTwo(TWO_UPSTREAMS.replace('    orders(first: 1) {', '    memos {'));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 5 })]);
    expect(result.errors[0]?.message).toContain('"memos"');
  });

  it('checks a gql.from document against the upstream it names', async () => {
    const result = await compileTwo(TWO_UPSTREAMS.replace('      title\n', '      total\n'));
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 15, column: 7 })]);
    expect(result.errors[0]?.message).toContain('"total"');
  });

  it('refuses a name the module does not read', async () => {
    const result = await compileTwo(TWO_UPSTREAMS.replace("gql.from('memos')", "gql.from('billing')"));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 11 })]);
    expect(result.errors[0]?.message).toContain("gql.from('billing')");
    expect(result.errors[0]?.message).toContain('"shop", "memos"');
  });

  it('refuses gql.from with anything but one string literal', async () => {
    const variable = TWO_UPSTREAMS.replace("gql.from('memos')", 'gql.from(MEMOS_NAME)');
    const twoArguments = TWO_UPSTREAMS.replace("gql.from('memos')", "gql.from('memos', 'shop')");
    for (const source of [variable, twoArguments]) {
      const result = await compileTwo(source);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 11, column: 19 })]);
      expect(result.errors[0]?.message).toContain('string literal');
      expect(result.documents).toHaveLength(1);
    }
  });

  it('refuses a gql.from call that is not a template tag', async () => {
    const source = TWO_UPSTREAMS.replace(
      "const MEMO_LIST = gql.from('memos')`",
      "const fromMemos = gql.from('memos');\nconst MEMO_LIST = fromMemos`",
    );
    const result = await compileTwo(source);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ stage: CompileStage.Graphql, line: 11 })]);
    expect(result.errors[0]?.message).toContain("directly as a template's tag");
  });

  it('follows gql.from on an aliased and a namespaced gql', async () => {
    const aliased =
      "import { gql as g } from 'symphony';\nconst Q = g.from('memos')`query { memos { id } }`;\nexport default function A() { return null; }";
    const namespaced =
      "import * as runtime from 'symphony';\nconst Q = runtime.gql.from('memos')`query { memos { id } }`;\nexport default function A() { return null; }";
    for (const source of [aliased, namespaced]) {
      // memos is a field of the memo upstream only, so this passes only when the document went there.
      const result = await compileTwo(source);
      expect(result.errors).toEqual([]);
      expect(result.documents).toEqual(['query { memos { id } }']);
    }
  });
});
