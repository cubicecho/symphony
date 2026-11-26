import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAllowedImports, RUNTIME_IMPORTS } from '../../server/modules/allowlist.ts';

describe('loadAllowedImports', () => {
  it('lists the runtime and the installed cubeui components', async () => {
    const allowed = await loadAllowedImports();
    for (const specifier of [...RUNTIME_IMPORTS, '@/components/card-layout', '@/components/ui/button']) {
      expect(allowed).toContain(specifier);
    }
  });

  it('drops extensions and skips tests, stories and other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'symphony-components-'));
    try {
      await mkdir(join(dir, 'ui'));
      for (const file of ['a.tsx', 'ui/b.ts', 'ui/b.test.tsx', 'a.stories.tsx', 'notes.md', 'style.css']) {
        await writeFile(join(dir, file), '');
      }
      const allowed = await loadAllowedImports(dir);
      expect([...allowed].toSorted()).toEqual([...RUNTIME_IMPORTS, '@/components/a', '@/components/ui/b'].toSorted());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
