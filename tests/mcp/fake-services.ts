// In-memory Services for the MCP tests: one upstream over the fixture schema, modules in a map, and a
// compile that fails on a marker so errors can be followed through.
import { buildSchema } from 'graphql';
import { createComponentCatalog } from '../../server/catalog/catalog.ts';
import { proposeConcepts } from '../../server/concepts/propose.ts';
import { badInput, notFound } from '../../server/core/errors.ts';
import {
  type ComponentCatalog,
  type ConceptProposalRecord,
  type ConceptRecord,
  type ModuleRecord,
  ModuleStatus,
  type PageService,
  ProposalStatus,
  type Services,
  UnifiedState,
  type Upstream,
} from '../../server/core/services.ts';
import { nameOf, readDefinition, schemasByName } from '../../server/gateway/concept-service.ts';
import { type CompileResult, CompileStage } from '../../server/modules/compile-result.ts';
import { FIXTURE_SDL, FIXTURE_URL } from '../fixtures/upstream.ts';

/** A source holding this fails the fake compile at line 3, column 7. */
export const BROKEN_MARKER = 'BROKEN';

/** The fake upstream's name. */
export const FAKE_UPSTREAM = 'shop';

/** The error the fake compile reports for a broken source. */
export const FAKE_ERROR = {
  stage: CompileStage.Graphql,
  message: 'Cannot query field "totl" on type "Order".',
  line: 3,
  column: 7,
};

/**
 * Compiles a source the fake way.
 *
 * @param source - The TSX source.
 * @returns Ok unless the source holds BROKEN_MARKER.
 */
function fakeCompile(source: string): CompileResult {
  const isBroken = source.includes(BROKEN_MARKER);
  return isBroken
    ? { ok: false, errors: [FAKE_ERROR], compiled: null, documents: [] }
    : { ok: true, errors: [], compiled: 'module.exports = {};', documents: ['{ orders { id } }'] };
}

/** What the fakes record, for assertions. */
export interface FakeCalls {
  executed: { id: string; query: string }[];
}

/**
 * Builds the fake services.
 *
 * @param [catalog] - The catalog; the real one over web/src/components when left out.
 * @param [extraUpstreams] - Upstreams listed after the fake ones, for the proposal tools.
 * @returns The services and the calls they saw.
 */
export function createFakeServices(
  catalog: ComponentCatalog = createComponentCatalog(),
  extraUpstreams: readonly Upstream[] = [],
): {
  services: Services;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { executed: [] };
  const schema = buildSchema(FIXTURE_SDL);
  const upstreams: Upstream[] = [
    {
      id: 'u1',
      name: FAKE_UPSTREAM,
      url: FIXTURE_URL,
      headers: [{ name: 'authorization', value: '${env:SYMPHONY_SECRET}' }],
      schema: {
        schema,
        sdl: FIXTURE_SDL,
        hash: 'h',
        typeCount: Object.keys(schema.getTypeMap()).length,
        fetchedAt: new Date('2026-11-20T00:00:00Z'),
      },
    },
    { id: 'u2', name: 'empty', url: 'http://empty.test/graphql', headers: [], schema: null },
    ...extraUpstreams,
  ];
  const find = async (idOrName: string) =>
    upstreams.find((upstream) => upstream.id === idOrName || upstream.name === idOrName) ?? null;
  const modules = new Map<string, ModuleRecord>();
  const unused = async (): Promise<never> => {
    throw new Error('Not used by the MCP tests.');
  };
  const pages: PageService = {
    list: unused,
    find: unused,
    add: unused,
    remove: unused,
    addItem: unused,
    updateItem: unused,
    moveItem: unused,
    removeItem: unused,
  };
  const concepts = new Map<string, ConceptRecord>();
  const proposals = new Map<string, ConceptProposalRecord>();
  const services: Services = {
    upstreams: {
      list: async () => upstreams,
      find,
      add: unused,
      update: unused,
      remove: unused,
      refresh: unused,
      execute: async (id, request) => {
        calls.executed.push({ id, query: request.query });
        return { data: { orders: [{ id: 'o3' }] } };
      },
    },
    modules: {
      list: async () => [...modules.values()],
      find: async (id) => modules.get(id) ?? null,
      remove: async (id) => modules.delete(id),
      check: async (_upstream, source) => fakeCompile(source),
      save: async (input) => {
        const upstream = await find(input.upstream);
        if (upstream === null) {
          throw notFound(`No upstream "${input.upstream}".`);
        }
        const previous = input.id === undefined ? undefined : modules.get(input.id);
        const isUnknownId = input.id !== undefined && previous === undefined;
        if (isUnknownId) {
          throw notFound(`No module "${input.id}".`);
        }
        const compile = fakeCompile(input.source);
        const module: ModuleRecord = {
          id: previous?.id ?? `m${modules.size + 1}`,
          name: input.name,
          description: input.description ?? '',
          upstreamId: upstream.id,
          source: input.source,
          compiled: compile.compiled,
          status: compile.ok ? ModuleStatus.Ready : ModuleStatus.Failed,
          errors: compile.errors,
          version: (previous?.version ?? 0) + 1,
          updatedAt: new Date(),
        };
        modules.set(module.id, module);
        return { module, compile };
      },
    },
    pages,
    catalog,
    concepts: {
      list: async () => [...concepts.values()],
      find: async (idOrName) =>
        [...concepts.values()].find((concept) => concept.id === idOrName || concept.name === idOrName) ?? null,
      save: async (definition) => {
        const name =
          typeof definition === 'object' && definition !== null && 'name' in definition ? definition.name : '';
        if (typeof name !== 'string' || name === '') {
          const problems = [
            { concept: '', member: null, operation: null, message: 'name: Required', line: null, column: null },
          ];
          throw badInput('The concepts cannot be served.\n- name: Required', { problems });
        }
        const now = new Date();
        const record: ConceptRecord = {
          id: concepts.get(name)?.id ?? `c${concepts.size + 1}`,
          name,
          definition,
          concept: null,
          problems: [],
          createdAt: now,
          updatedAt: now,
        };
        concepts.set(name, record);
        return record;
      },
      remove: async (idOrName) => {
        const found = [...concepts.values()].find((concept) => concept.id === idOrName || concept.name === idOrName);
        return found === undefined ? false : concepts.delete(found.name);
      },
    },
    conceptProposals: {
      // The real proposer and checks over the fake upstreams; proposals are kept in a map.
      propose: async (names) => {
        const picked = upstreams.filter((upstream) => names === undefined || names.includes(upstream.name));
        const found = proposeConcepts(schemasByName(picked));
        const drafts = found.drafts.map((draft) => ({
          ...draft,
          problems: readDefinition(draft.definition, upstreams).problems,
        }));
        return { drafts, notReady: found.notReady };
      },
      list: async () => [...proposals.values()],
      find: async (id) => proposals.get(id) ?? null,
      submit: async (input) => {
        const previous = input.id === undefined ? undefined : proposals.get(input.id);
        const isUnknownId = input.id !== undefined && previous === undefined;
        if (isUnknownId) {
          throw notFound(`There is no concept proposal ${input.id}.`);
        }
        const now = new Date();
        const record: ConceptProposalRecord = {
          id: previous?.id ?? `p${proposals.size + 1}`,
          name: nameOf(input.definition),
          definition: input.definition,
          status: ProposalStatus.Pending,
          source: input.source,
          problems: readDefinition(input.definition, upstreams).problems,
          note: input.note ?? null,
          reason: null,
          conceptId: null,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        proposals.set(record.id, record);
        return record;
      },
      accept: unused,
      reject: unused,
    },
    wiring: {
      effective: async () => ({ wiring: [], problems: [] }),
      find: async () => null,
      setOverride: unused,
      clearOverride: async () => false,
    },
    unified: {
      status: () => ({ state: UnifiedState.Starting, composedAt: null, sources: [], problems: [], lastError: null }),
    },
  };
  return { services, calls };
}
