// Prints the admin API's schema for codegen. Run by `npm run codegen`. It needs only the SDL, never a database.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildSchema, printSchema } from 'graphql';
import { TYPE_DEFS } from './type-defs.ts';

const target = fileURLToPath(new URL('../../schema.graphql', import.meta.url));
await writeFile(target, `${printSchema(buildSchema(TYPE_DEFS))}\n`, 'utf-8');
console.log(`[codegen] wrote ${target}`);
