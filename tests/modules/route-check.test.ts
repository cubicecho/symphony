import { readFile } from 'node:fs/promises';
import { RUNTIME_IMPORTS } from '../../server/modules/allowlist.ts';
import { compileModule } from '../../server/modules/compile.ts';
import { type CompileResult, CompileStage } from '../../server/modules/compile-result.ts';
import { pathFitsRoute } from '../../server/modules/route-check.ts';
import { matchRoute } from '../../web/src/modules/route-match.ts';

const allowedImports = new Set<string>(RUNTIME_IMPORTS);

/**
 * Compiles a module with no upstream schema: these tests are about its routes.
 *
 * @param source - The TSX.
 * @returns The result.
 */
function compile(source: string): Promise<CompileResult> {
  return compileModule({
    source,
    fileName: 'routes-module',
    upstreams: [{ name: 'shop', schema: null }],
    allowedImports,
  });
}

/**
 * Builds a module whose body holds the given lines, under a two-route table.
 *
 * @param body - JSX and statements inside the component, one per line, from line 6.
 * @returns The source.
 */
function withRoutes(body: string): string {
  return `import { Routes, RouteLink, useRoute } from 'symphony';

const ROUTES = { '/': () => <List />, '/orders/:id': () => <Detail />, '/orders/new': () => null };

function List() {
${body}
  return null;
}

function Detail() {
  return null;
}

export default function Orders() {
  return <Routes routes={ROUTES} />;
}
`;
}

/**
 * The ROUTES errors of a result, as stage and line.
 *
 * @param result - The compile.
 * @returns `[stage, line]` pairs.
 */
function placed(result: CompileResult): [string, number | null][] {
  return result.errors.map((error) => [error.stage, error.line]);
}

describe('the route check', () => {
  it('passes paths that match a route, literal and templated', async () => {
    const result = await compile(
      withRoutes(`  const { navigate } = useRoute();
  const id = 'o3';
  navigate('/orders/new');
  navigate(\`/orders/\${id}\`);
  const link = <RouteLink to="/">Home</RouteLink>;
  const other = <RouteLink to={\`/orders/\${id}/\`} />;`),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports a RouteLink and a navigate with a typo, with their lines', async () => {
    const result = await compile(
      withRoutes(`  const route = useRoute();
  route.navigate('/ordrs/o3');
  const link = <RouteLink to="/orders/o3/lines">Lines</RouteLink>;`),
    );
    expect(result.ok).toBe(false);
    expect(placed(result)).toEqual([
      [CompileStage.Routes, 7],
      [CompileStage.Routes, 8],
    ]);
    expect(result.errors[0]).toMatchObject({ column: 18 });
    expect(result.errors[0]?.message).toContain(`navigate "/ordrs/o3" matches no route`);
    expect(result.errors[0]?.message).toContain(`"/", "/orders/:id", "/orders/new"`);
    expect(result.errors[1]?.message).toContain('RouteLink to "/orders/o3/lines"');
  });

  it('lets a ${…} segment match only a :param segment', async () => {
    const source = `import { Routes, RouteLink } from 'symphony';
export default function A() {
  const id = 'x';
  return <Routes routes={{ '/': () => <RouteLink to={\`/settings/\${id}\`} />, '/settings/general': () => null }} />;
}`;
    const result = await compile(source);
    expect(placed(result)).toEqual([[CompileStage.Routes, 4]]);
    expect(result.errors[0]?.message).toContain('`/settings/${…}`');
  });

  it('follows navigate destructured under another name, and useRoute().navigate', async () => {
    const result = await compile(
      withRoutes(`  const { navigate: go } = useRoute();
  go('/nope');
  useRoute().navigate('/nope/either');`),
    );
    expect(placed(result)).toEqual([
      [CompileStage.Routes, 7],
      [CompileStage.Routes, 8],
    ]);
  });

  it('follows aliased and namespaced imports', async () => {
    const source = `import * as runtime from 'symphony';
import { RouteLink as Go } from 'symphony';
export default function A() {
  return <runtime.Routes routes={{ '/': () => <><Go to="/missing" /><runtime.RouteLink to="/gone" /></> }} />;
}`;
    const result = await compile(source);
    expect(placed(result)).toEqual([
      [CompileStage.Routes, 4],
      [CompileStage.Routes, 4],
    ]);
  });

  it('skips paths it cannot read, and a navigate that is not the runtime one', async () => {
    const result = await compile(
      withRoutes(`  const { navigate } = useRoute();
  const target = '/anywhere';
  navigate(target);
  navigate(\`\${target}/x\`);
  const window = { navigate: (path: string) => path };
  window.navigate('/not-a-route');
  const link = <RouteLink to={target} />;`),
    );
    expect(result.errors).toEqual([]);
  });

  it('leaves alone a same-named navigate in another component', async () => {
    const source = `import { Routes, useRoute } from 'symphony';
function List() {
  const { navigate } = useRoute();
  navigate('/');
  return null;
}
function Other({ navigate }: { navigate: (path: string) => void }) {
  navigate('/somewhere/else');
  const route = { navigate: (path: string) => path };
  route.navigate('/nor/here');
  return null;
}
export default function A() {
  return <Routes routes={{ '/': () => <List /> }} />;
}`;
    expect((await compile(source)).errors).toEqual([]);
  });

  it('reads the table a name is bound to where Routes uses it, not a top-level one it shadows', async () => {
    const source = `import { Routes, RouteLink } from 'symphony';
const ROUTES = { '/': () => null };
export default function A() {
  const ROUTES = { '/': () => <RouteLink to="/local" />, '/local': () => null };
  return <Routes routes={ROUTES} />;
}`;
    const unread = `import { Routes, RouteLink } from 'symphony';
const ROUTES = { '/': () => null };
function build() {
  return { '/': () => <RouteLink to="/built" />, '/built': () => null };
}
export default function A() {
  const ROUTES = build();
  return <Routes routes={ROUTES} />;
}`;
    expect((await compile(source)).errors).toEqual([]);
    expect((await compile(unread)).errors).toEqual([]);
  });

  it('ignores a local component that shadows the runtime one', async () => {
    const source = `import { Routes } from 'symphony';
function RouteLink({ to }: { to: string }) {
  return <a href={to} />;
}
export default function A() {
  return <Routes routes={{ '/': () => <RouteLink to="https://example.com" /> }} />;
}`;
    expect((await compile(source)).errors).toEqual([]);
  });

  it('checks nothing against a table it cannot read, or when there is no Routes', async () => {
    const spread = `import { Routes, RouteLink } from 'symphony';
const MORE = { '/b': () => null };
export default function A() {
  return <Routes routes={{ ...MORE, '/': () => <RouteLink to="/b" /> }} />;
}`;
    const none = `import { RouteLink } from 'symphony';
export default function A() {
  return <RouteLink to="/anything" />;
}`;
    expect((await compile(spread)).errors).toEqual([]);
    expect((await compile(none)).errors).toEqual([]);
  });

  it('reports a path or a route that does not start with /', async () => {
    const source = `import { Routes, RouteLink } from 'symphony';
export default function A() {
  return <Routes routes={{ '/': () => <RouteLink to="orders" />, orders: () => null }} />;
}`;
    const result = await compile(source);
    expect(placed(result)).toEqual([
      [CompileStage.Routes, 3],
      [CompileStage.Routes, 3],
    ]);
    expect(result.errors[0]?.message).toContain('RouteLink to "orders" is not a module path');
    expect(result.errors[1]?.message).toContain('Route "orders" in Routes is not a module path');
  });
});

describe('the contract', () => {
  it('compiles the routing example in docs/module-contract.md', async () => {
    const contract = await readFile(new URL('../../docs/module-contract.md', import.meta.url), 'utf8');
    const section = contract.slice(contract.indexOf('## Routes inside a module'));
    const example = /```tsx\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
    const result = await compileModule({
      source: example,
      fileName: 'contract-example',
      upstreams: [{ name: 'shop', schema: null }],
      allowedImports: new Set([...allowedImports, '@/components/ui/button']),
    });
    expect(example).toContain('<Routes');
    expect(result.errors).toEqual([]);
  });
});

describe('the compile check and the runtime matcher', () => {
  // The compiler and the browser each match paths (server and web share no code). Every case must come out the same.
  const cases: [string[], string][] = [
    [['/'], '/'],
    [['/'], '/a'],
    [['/orders/:id'], '/orders/o3'],
    [['/orders/:id'], '/orders/o3/'],
    [['/orders/:id'], '/orders'],
    [['/orders/new'], '/orders/new'],
    [['/orders/new'], '/orders/old'],
    [['/a/:b/c'], '/a/x/c'],
    [['/a/:b/c'], '/a/x/d'],
    [['/a'], '//a'],
  ];

  it.each(cases)('agrees on %j for %s', (routes, path) => {
    const inBrowser = matchRoute(routes, path) !== null;
    const inCompiler = routes.some((route) => pathFitsRoute(route, path));
    expect(inCompiler).toBe(inBrowser);
  });
});
