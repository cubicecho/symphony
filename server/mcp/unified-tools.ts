// The tools that shape the unified API: concepts, the wiring that lines sources up, and how its composition went.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notFound } from '../core/errors.ts';
import type { ConceptRecord, Services } from '../core/services.ts';
import { UNIFIED_ENDPOINT } from '../gateway/unified-service.ts';
import { CONCEPT_SOURCE_NAME } from '../gateway/wiring.ts';
import { didYouMean, jsonResult } from './answers.ts';
import { guard } from './tool-kit.ts';

/** How to get a smaller concept answer. */
const NARROW_CONCEPTS = 'Ask for one concept by name with `get_concept`.';
/** How to get a smaller wiring answer. */
const NARROW_WIRING = 'Pass `source` to read one source at a time.';

/** The `concept` argument the concept tools take. */
const conceptArg = z.string().min(1).describe("The concept's name (from `list_concepts`), or its id.");

/** The `source` argument the wiring tools take. */
const sourceArg = z
  .string()
  .min(1)
  .describe(`An upstream's name (from \`list_upstreams\`), or "${CONCEPT_SOURCE_NAME}" for the concept subgraph.`);

/**
 * Finds a concept by id or name.
 *
 * @param services - The shared services.
 * @param idOrName - What the agent passed.
 * @returns The concept.
 * @throws NOT_FOUND, naming close concept names, when there is none.
 */
async function requireConcept(services: Services, idOrName: string): Promise<ConceptRecord> {
  const concept = await services.concepts.find(idOrName);
  if (concept !== null) {
    return concept;
  }
  const names = (await services.concepts.list()).map((one) => one.name);
  throw notFound(`No concept "${idOrName}".${didYouMean(idOrName, names)} \`list_concepts\` names them.`);
}

/**
 * Shapes a concept for an answer.
 *
 * @param concept - The stored concept.
 * @returns Its id, name, whether it is served, its problems and its definition.
 */
function conceptAnswer(concept: ConceptRecord) {
  return {
    id: concept.id,
    name: concept.name,
    servable: concept.problems.length === 0,
    problems: concept.problems,
    definition: concept.definition,
  };
}

/**
 * Registers list_concepts, get_concept, save_concept, remove_concept, get_wiring, set_wiring_override,
 * clear_wiring_override and get_unified_status.
 *
 * @param server - The MCP server.
 * @param services - The shared services.
 */
export function registerUnifiedTools(server: McpServer, services: Services): void {
  server.registerTool(
    'list_concepts',
    {
      title: 'List concepts',
      description: `Lists the concepts: entities (a Team, say) read and written across several upstreams as one, served by the unified API at ${UNIFIED_ENDPOINT}. Each row says whether it is served now and how many problems stop it; \`get_concept\` gives one in full.`,
      annotations: { readOnlyHint: true },
    },
    guard('list_concepts', async () => {
      const concepts = await services.concepts.list();
      const rows = concepts.map((concept) => ({
        id: concept.id,
        name: concept.name,
        servable: concept.problems.length === 0,
        problemCount: concept.problems.length,
        members: concept.concept?.members.map((member) => member.upstream) ?? [],
      }));
      return jsonResult(rows, NARROW_CONCEPTS);
    }),
  );

  server.registerTool(
    'get_concept',
    {
      title: 'Get a concept',
      description:
        "Returns one concept: its definition as saved, and the problems that stop it being served now, each placed in a member's document (`member`, `operation`, `line`, `column`) when it has a place. An upstream's schema change can break a saved concept.",
      inputSchema: { concept: conceptArg },
      annotations: { readOnlyHint: true },
    },
    guard('get_concept', async ({ concept }) =>
      jsonResult(
        conceptAnswer(await requireConcept(services, concept)),
        'The definition is long; read it in Symphony.',
      ),
    ),
  );

  server.registerTool(
    'save_concept',
    {
      title: 'Save a concept',
      description:
        "Stores a concept, replacing the one with the same name, and recomposes the unified API. The definition is checked against every member upstream's cached schema first: a refusal lists each problem with where it is, so fix those and save again.",
      inputSchema: {
        definition: z
          .record(z.string(), z.unknown())
          .describe('The concept as JSON: its name, fields and members, each member with its four documents.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard('save_concept', async ({ definition }) => {
      const saved = await services.concepts.save(definition);
      return jsonResult(
        { saved: conceptAnswer(saved), next: '`get_unified_status` shows when the unified API serves it.' },
        NARROW_CONCEPTS,
      );
    }),
  );

  server.registerTool(
    'remove_concept',
    {
      title: 'Remove a concept',
      description:
        'Deletes a concept and recomposes the unified API without it. The upstreams and their data are not touched.',
      inputSchema: { concept: conceptArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard('remove_concept', async ({ concept }) => {
      const { id, name } = await requireConcept(services, concept);
      await services.concepts.remove(id);
      return jsonResult({ removed: name }, '');
    }),
  );

  server.registerTool(
    'get_wiring',
    {
      title: 'Get source wiring',
      description:
        'Returns the wiring the unified API composes each source with: type and field renames and merge keys, as generated from the concepts and with any override applied, plus where each entry came from (`origins`).',
      inputSchema: { source: sourceArg.optional().describe('One source. Left out for every source that has wiring.') },
      annotations: { readOnlyHint: true },
    },
    guard('get_wiring', async ({ source }) => {
      if (source === undefined) {
        return jsonResult(await services.wiring.effective(), NARROW_WIRING);
      }
      const wiring = await services.wiring.find(source);
      if (wiring === null) {
        throw notFound(`"${source}" has no wiring: no concept generates any for it and it has no override.`);
      }
      return jsonResult(wiring, NARROW_WIRING);
    }),
  );

  server.registerTool(
    'set_wiring_override',
    {
      title: 'Set a wiring override',
      description:
        "Stores a source's wiring override, replacing any earlier one, and recomposes the unified API. `renames.types` and `renames.fields` (keyed `SourceType.field`) map to the new name, or to null to drop a generated rename; `mergeKeys` replace generated keys for the same type; `removeMergeKeys` drops generated keys by type.",
      inputSchema: {
        source: sourceArg,
        override: z.record(z.string(), z.unknown()).describe('The override as JSON; `upstream` may be left out.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard('set_wiring_override', async ({ source, override }) =>
      jsonResult(await services.wiring.setOverride(source, override), NARROW_WIRING),
    ),
  );

  server.registerTool(
    'clear_wiring_override',
    {
      title: 'Clear a wiring override',
      description: "Deletes a source's wiring override, so it is composed with its generated wiring alone.",
      inputSchema: { source: sourceArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard('clear_wiring_override', async ({ source }) => {
      const wasSet = await services.wiring.clearOverride(source);
      return jsonResult({ source, cleared: wasSet }, '');
    }),
  );

  server.registerTool(
    'get_unified_status',
    {
      title: 'Get unified API status',
      description: `Says whether the unified API at ${UNIFIED_ENDPOINT} is serving (\`starting\`, \`ready\` or \`failed\`), when it was last composed, its sources, the concept and wiring problems that left things out, and the last failed composition with its issues. A failed recompose keeps the last good one serving.`,
      annotations: { readOnlyHint: true },
    },
    guard('get_unified_status', async () =>
      jsonResult({ endpoint: UNIFIED_ENDPOINT, ...services.unified.status() }, 'Fix the listed problems first.'),
    ),
  );
}
