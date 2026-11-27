// The concept proposer over generic fixture schemas: candidates by name, readiness, field modes, and which member
// documents it writes or leaves out.
import { buildSchema } from 'graphql';
import { type Concept, conceptSchema } from '../../server/concepts/concept.ts';
import { type ConceptDraft, Confidence, proposeConcepts } from '../../server/concepts/propose.ts';
import { validateConcepts } from '../../server/concepts/validate.ts';
import { PROPOSAL_SCHEMAS, WAREHOUSE_CREATE } from '../fixtures/proposal-upstreams.ts';

/**
 * Finds the draft with a name.
 *
 * @param drafts - The drafts.
 * @param name - The concept's name.
 * @returns The draft.
 */
function draftNamed(drafts: readonly ConceptDraft[], name: string): ConceptDraft {
  const draft = drafts.find((one) => one.definition.name === name);
  if (draft === undefined) {
    throw new Error(`No draft called ${name}; drafts: ${drafts.map((one) => one.definition.name).join(', ')}.`);
  }
  return draft;
}

describe('proposeConcepts', () => {
  const proposals = proposeConcepts(PROPOSAL_SCHEMAS);
  const widget = draftNamed(proposals.drafts, 'Widget');

  it('drafts one concept from types whose names match once a prefix is removed', () => {
    expect(proposals.drafts.map((draft) => draft.definition.name)).toEqual(['Widget']);
    expect(widget.definition.members.map((member) => member.upstream)).toEqual(['catalog', 'warehouse']);
    expect(widget.reasons[0]).toMatchObject({ about: 'Widget', confidence: Confidence.Medium });
    expect(widget.reasons[0]?.reason).toMatch(/catalog\.CatalogWidget, warehouse\.AcmeWidget match as Widget/);
  });

  it('shares fields every member has with one type, and gives the rest to an owner', () => {
    expect(widget.definition.fields).toEqual([
      { name: 'name', mode: 'shared' },
      { name: 'price', mode: 'owned', owner: 'catalog' },
      { name: 'sku', mode: 'owned', owner: 'catalog' },
      { name: 'stock', mode: 'owned', owner: 'warehouse' },
    ]);
    expect(widget.reasons).toContainEqual({
      about: 'field stock',
      reason: 'Only warehouse has stock, so warehouse owns it.',
      confidence: Confidence.High,
    });
  });

  it('writes the fetch from the lookup by id, selecting what the member writes', () => {
    const [catalog, warehouse] = widget.definition.members;
    expect(catalog?.documents.fetch).toBe('query ($id: ID!) { catalogWidget(id: $id) { id name price sku } }');
    expect(warehouse?.documents.fetch).toBe('query ($id: ID!) { acmeWidget(id: $id) { id name stock } }');
  });

  it('maps create, update and delete arguments by name, into input objects too', () => {
    const [catalog, warehouse] = widget.definition.members;
    expect(catalog?.documents).toMatchObject({
      create:
        'mutation ($id: ID!, $name: String!, $price: Float, $sku: String!) { createCatalogWidget(input: { id: $id, name: $name, price: $price, sku: $sku }) { id } }',
      update:
        'mutation ($id: ID!, $name: String, $price: Float, $sku: String) { updateCatalogWidget(id: $id, name: $name, price: $price, sku: $sku) { id } }',
      delete: 'mutation ($id: ID!) { deleteCatalogWidget(id: $id) }',
    });
    expect(warehouse?.documents.update).toBe(
      'mutation ($id: ID!, $name: String, $stock: Int) { updateAcmeWidget(id: $id, name: $name, stock: $stock) { id } }',
    );
    expect(warehouse?.documents.delete).toBe('mutation ($id: ID!) { deleteAcmeWidget(id: $id) { id } }');
  });

  it('leaves out a write whose required arguments match no field, and says why', () => {
    const [, warehouse] = widget.definition.members;
    expect(warehouse?.documents.create).toBeUndefined();
    const reason = widget.reasons.find((one) => one.about === 'warehouse create');
    expect(reason).toMatchObject({ confidence: Confidence.Low });
    expect(reason?.reason).toMatch(/required `location` matches no field warehouse writes/);
  });

  it('reports a candidate whose types lack an id or a lookup as not ready', () => {
    expect(proposals.notReady).toEqual([
      {
        name: 'Gizmo',
        types: [
          {
            upstream: 'warehouse',
            type: 'AcmeGizmo',
            reason: expect.stringMatching(
              /needs `id: ID!` and a lookup by id \(AcmeGizmo has no `id: ID!`; no Query field/,
            ),
          },
          { upstream: 'storefront', type: 'Gizmo', reason: 'Ready, but no other member is.' },
        ],
      },
    ]);
  });

  it('drafts what the validator accepts once the missing document is filled in', () => {
    const [catalog, warehouse] = widget.definition.members;
    const completed = {
      ...widget.definition,
      members: [catalog, { ...warehouse, documents: { ...warehouse?.documents, create: WAREHOUSE_CREATE } }],
    };
    const parsed = conceptSchema.parse(completed) as Concept;
    expect(validateConcepts([parsed], PROPOSAL_SCHEMAS)).toEqual([]);
  });

  it('matches names case-insensitively and with a suffix removed, with high confidence for an exact match', () => {
    const schemas = new Map([
      ['one', buildSchema('type BOX { id: ID! size: Int } type Query { box(id: ID!): BOX }')],
      ['two', buildSchema('type Box { id: ID! size: Int } type Query { box(id: ID!): Box }')],
      ['three', buildSchema('type BoxRecord { id: ID! size: Int } type Query { boxRecord(id: ID!): BoxRecord }')],
    ]);
    const [draft] = proposeConcepts(schemas).drafts;
    expect(draft?.definition.members.map((member) => member.upstream)).toEqual(['one', 'two', 'three']);
    expect(draft?.definition.fields).toEqual([{ name: 'size', mode: 'shared' }]);
    const exact = proposeConcepts(new Map([...schemas].slice(0, 2))).drafts[0];
    expect(exact?.reasons[0]?.confidence).toBe(Confidence.High);
  });

  it('owns a field whose types differ, and warns it will not compose', () => {
    const schemas = new Map([
      ['one', buildSchema('type Box { id: ID! size: Int } type Query { box(id: ID!): Box }')],
      ['two', buildSchema('type AcmeBox { id: ID! size: String } type Query { acmeBox(id: ID!): AcmeBox }')],
    ]);
    const [draft] = proposeConcepts(schemas).drafts;
    expect(draft?.definition.fields).toEqual([{ name: 'size', mode: 'owned', owner: 'one' }]);
    const size = draft?.reasons.find((reason) => reason.about === 'field size');
    expect(size).toMatchObject({ confidence: Confidence.Low });
    expect(size?.reason).toMatch(/types differ \(Int in one, String in two\).*won't compose/);
  });

  it("warns when a member's own mutations clash with the concept's generated ones", () => {
    const sdl = (prefix: string) => `
      type ${prefix}Box { id: ID! size: Int }
      type Query { box(id: ID!): ${prefix}Box }
      type Mutation { deleteBox(id: ID!): Boolean! }
    `;
    const [draft] = proposeConcepts(
      new Map([
        ['one', buildSchema(sdl(''))],
        ['two', buildSchema(sdl('Acme'))],
      ]),
    ).drafts;
    const clashes = draft?.reasons.filter((reason) => /would clash/.test(reason.reason)) ?? [];
    expect(clashes.map((reason) => reason.about)).toEqual(['member one', 'member two']);
    expect(clashes[0]?.reason).toMatch(/one has its own deleteBox/);
  });

  it('proposes nothing from one upstream alone', () => {
    const proposals = proposeConcepts(
      new Map([['catalog', PROPOSAL_SCHEMAS.get('catalog') ?? buildSchema('type Query { a: Int }')]]),
    );
    expect(proposals).toEqual({ drafts: [], notReady: [] });
  });
});
