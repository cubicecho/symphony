import {
  itemPathOf,
  itemSearchKey,
  moduleSearchOf,
  pathOfSplat,
  splatOf,
  withItemPath,
} from '../../web/src/modules/module-url.ts';
import { matchRoute, segmentsOf } from '../../web/src/modules/route-match.ts';

const ORDERS = ['/', '/orders/:id', '/orders/new', '/orders/:id/lines/:line'];

describe('matchRoute', () => {
  it('matches the root, and ignores a trailing slash', () => {
    expect(matchRoute(ORDERS, '/')).toEqual({ route: '/', params: {} });
    expect(matchRoute(ORDERS, '')).toEqual({ route: '/', params: {} });
    expect(matchRoute(['/orders'], '/orders/')).toEqual({ route: '/orders', params: {} });
  });

  it('reads :param segments, decoded', () => {
    expect(matchRoute(ORDERS, '/orders/o3')).toEqual({ route: '/orders/:id', params: { id: 'o3' } });
    expect(matchRoute(ORDERS, '/orders/o%203/lines/2')).toEqual({
      route: '/orders/:id/lines/:line',
      params: { id: 'o 3', line: '2' },
    });
  });

  it('keeps a segment that is not valid percent-encoding as it is', () => {
    expect(matchRoute(ORDERS, '/orders/100%')?.params).toEqual({ id: '100%' });
  });

  it('prefers a literal segment over a parameter, whatever the order', () => {
    expect(matchRoute(ORDERS, '/orders/new')).toEqual({ route: '/orders/new', params: {} });
    expect(matchRoute(['/:a/b', '/a/:b'], '/a/b')?.route).toBe('/a/:b');
  });

  it('takes the first of two equally specific routes', () => {
    expect(matchRoute(['/:a', '/:b'], '/x')).toEqual({ route: '/:a', params: { a: 'x' } });
  });

  it('matches nothing for an unknown path, or a different number of segments', () => {
    expect(matchRoute(ORDERS, '/customers')).toBeNull();
    expect(matchRoute(ORDERS, '/orders/o3/lines')).toBeNull();
    expect(matchRoute([], '/')).toBeNull();
  });

  it('splits paths into segments', () => {
    expect(segmentsOf('/')).toEqual([]);
    expect(segmentsOf('/a//b/')).toEqual(['a', 'b']);
  });
});

describe('module URLs', () => {
  it('keeps an item path under m.<itemId>', () => {
    expect(itemSearchKey('4f2a')).toBe('m.4f2a');
    expect(itemPathOf({ 'm.4f2a': '/orders/o3' }, '4f2a')).toBe('/orders/o3');
    expect(itemPathOf({}, '4f2a')).toBe('/');
    expect(itemPathOf({ 'm.4f2a': 3 }, '4f2a')).toBe('/');
  });

  it('sets one item path and leaves the rest of the search alone, dropping the key at the root', () => {
    const search = { 'm.a': '/x', tab: 'two' };
    expect(withItemPath(search, 'b', '/y')).toEqual({ 'm.a': '/x', 'm.b': '/y', tab: 'two' });
    expect(withItemPath(search, 'a', '/')).toEqual({ tab: 'two' });
    expect(search).toEqual({ 'm.a': '/x', tab: 'two' });
  });

  it('validates a search: drops m.* keys that are not strings, keeps everything else', () => {
    expect(moduleSearchOf({ 'm.a': '/x', 'm.b': 4, page: 2, q: 'text' })).toEqual({ 'm.a': '/x', page: 2, q: 'text' });
  });

  it('makes an item path without its leading slash a module path', () => {
    expect(itemPathOf({ 'm.x': 'orders/o3' }, 'x')).toBe('/orders/o3');
    expect(moduleSearchOf({ 'm.x': 'orders/o3', q: 'orders' })).toEqual({ 'm.x': '/orders/o3', q: 'orders' });
    expect(splatOf(itemPathOf({ 'm.x': 'orders/o3' }, 'x'))).toBe('orders/o3');
    expect(splatOf('orders/o3')).toBe('orders/o3');
  });

  it('turns a module path into the full-page splat and back', () => {
    expect(splatOf('/orders/o3')).toBe('orders/o3');
    expect(splatOf('/')).toBe('');
    expect(pathOfSplat('orders/o3')).toBe('/orders/o3');
    expect(pathOfSplat(undefined)).toBe('/');
    expect(pathOfSplat('')).toBe('/');
  });
});
