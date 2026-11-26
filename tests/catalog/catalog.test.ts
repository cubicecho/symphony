import { describe, expect, it } from 'vitest';
import { createComponentCatalog } from '../../server/catalog/catalog.ts';
import { parseExports } from '../../server/catalog/exports.ts';
import { splitSections } from '../../server/catalog/markdown.ts';

const catalog = createComponentCatalog();

describe('component catalog', () => {
  it('lists the installed components by import path, with their exports and description', async () => {
    const components = await catalog.list();
    const card = components.find((component) => component.importPath === '@/components/card-layout');
    expect(card?.exports).toContain('CardLayout');
    expect(card?.description).not.toBe('');
    expect(components.map((component) => component.importPath)).toContain('@/components/ui/button');
  });

  it('leaves *-base.ts internals out', async () => {
    const paths = (await catalog.list()).map((component) => component.importPath);
    expect(paths.filter((path) => path.endsWith('-base'))).toEqual([]);
  });

  it('answers CardLayout with its import line and props section', async () => {
    const docs = (await catalog.docs('CardLayout')) ?? '';
    expect(docs).toContain("from '@/components/card-layout';");
    expect(docs).toContain('<!-- props:CardLayout -->');
    expect(docs).toContain('`contentSlot`');
  });

  it('finds a component by import path and by registry name', async () => {
    const byPath = await catalog.docs('@/components/card-layout');
    const byName = await catalog.docs('card-layout');
    expect(byPath).toContain('<!-- props:CardLayout -->');
    expect(byName).toBe(byPath);
  });

  it('answers the vocabulary and index topics', async () => {
    expect(await catalog.docs('vocabulary')).toContain('slot vocabulary');
    const index = (await catalog.docs('index')) ?? '';
    expect(index).toContain('# cubeui');
    expect(index).not.toMatch(/^---/);
    expect(index).toContain('`layout/cards`');
  });

  it('answers null for an unknown name', async () => {
    expect(await catalog.docs('NoSuchThing')).toBeNull();
  });
});

describe('parseExports', () => {
  it('reads declared and listed value exports, and skips types', () => {
    const source = [
      'export type Props = {};',
      'export interface Other {}',
      'export function CardLayout() {}',
      'export async function load() {}',
      'export const helper = 1;',
      'export {',
      '  Button,',
      '  type ButtonProps,',
      '  inner as Outer,',
      '};',
      'export type { Hidden };',
    ].join('\n');
    expect(parseExports(source)).toEqual(['CardLayout', 'load', 'helper', 'Button', 'Outer']);
  });
});

describe('splitSections', () => {
  it('ignores headings in code fences and records props markers on the section that holds them', () => {
    const text = ['# Doc', '## Cards', '```md', '## not a heading', '```', '<!-- props:CardLayout -->', '## Next'].join(
      '\n',
    );
    const sections = splitSections({ path: 'a.md', text });
    expect(sections.map((section) => section.heading)).toEqual(['Doc', 'Cards', 'Next']);
    expect(sections[1]?.props).toEqual(['CardLayout']);
    expect(sections[0]?.props).toEqual([]);
  });
});
