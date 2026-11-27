import {
  draftSourceOf,
  groupReasons,
  labelOf,
  lowestConfidence,
  type ProposalReason,
  reasonSubjectOf,
  STATUS_LABELS,
  statusOfFilter,
  toggleUpstream,
  unsureReasonCount,
  upstreamChoiceOf,
} from '../../web/src/concepts/concept-proposals.ts';

const reasons: ProposalReason[] = [
  { about: 'shop fetch', reason: 'product(id) is the fetch.', confidence: 'HIGH' },
  { about: 'Product', reason: 'Same name in both.', confidence: 'HIGH' },
  { about: 'field title', reason: 'Both have title.', confidence: 'HIGH' },
  { about: 'member crm', reason: 'Its Item is left out.', confidence: 'HIGH' },
  { about: 'shop create', reason: 'No createProduct.', confidence: 'LOW' },
  { about: 'field title', reason: 'Types differ a little.', confidence: 'MEDIUM' },
  { about: 'field price', reason: 'Only shop has price.', confidence: 'HIGH' },
];

describe('reasonSubjectOf', () => {
  it('reads fields, members and documents, and takes anything else as the concept', () => {
    expect(reasonSubjectOf('field title')).toEqual({ subject: 'field', label: 'Field title' });
    expect(reasonSubjectOf('member crm')).toEqual({ subject: 'member', label: 'Member crm' });
    expect(reasonSubjectOf('shop update')).toEqual({ subject: 'document', label: 'shop · update' });
    expect(reasonSubjectOf('Product')).toEqual({ subject: 'concept', label: 'Concept' });
    expect(reasonSubjectOf('Order Line')).toEqual({ subject: 'concept', label: 'Concept' });
  });
});

describe('groupReasons', () => {
  it('groups by about, orders concept, fields, members, documents, and keeps the proposer order within each', () => {
    const groups = groupReasons(reasons);
    expect(groups.map((group) => group.about)).toEqual([
      'Product',
      'field title',
      'field price',
      'member crm',
      'shop fetch',
      'shop create',
    ]);
    expect(groups[1]?.reasons.map((reason) => reason.reason)).toEqual(['Both have title.', 'Types differ a little.']);
  });

  it('gives each group its least sure confidence', () => {
    const byAbout = new Map(groupReasons(reasons).map((group) => [group.about, group.confidence]));
    expect(byAbout.get('field title')).toBe('MEDIUM');
    expect(byAbout.get('shop create')).toBe('LOW');
    expect(byAbout.get('Product')).toBe('HIGH');
  });

  it('returns nothing for no reasons', () => {
    expect(groupReasons([])).toEqual([]);
  });
});

describe('lowestConfidence and unsureReasonCount', () => {
  it('picks the least sure and counts what is not HIGH', () => {
    expect(lowestConfidence(['HIGH', 'MEDIUM'])).toBe('MEDIUM');
    expect(lowestConfidence([])).toBe('HIGH');
    expect(unsureReasonCount(reasons)).toBe(2);
  });
});

describe('upstreamChoiceOf', () => {
  it('leaves out the built-in upstream and splits the rest by whether a schema is cached', () => {
    const choice = upstreamChoiceOf([
      { name: 'unified', builtIn: true, schema: { typeCount: 3 } },
      { name: 'shop', builtIn: false, schema: { typeCount: 10 } },
      { name: 'new', builtIn: false, schema: null },
      { name: 'crm', builtIn: false, schema: { typeCount: 4 } },
    ]);
    expect(choice).toEqual({ ready: ['shop', 'crm'], unfetched: ['new'] });
  });
});

describe('toggleUpstream', () => {
  const order = ['shop', 'crm', 'billing'];

  it('turns one off or on, keeping the listed order', () => {
    expect(toggleUpstream(order, 'crm', order)).toEqual(['shop', 'billing']);
    expect(toggleUpstream(['billing'], 'shop', order)).toEqual(['shop', 'billing']);
  });

  it('drops a chosen name that is no longer listed', () => {
    expect(toggleUpstream(['gone', 'shop'], 'crm', order)).toEqual(['shop', 'crm']);
  });
});

describe('draftSourceOf', () => {
  it('is GENERATED for the draft as drafted and USER once it was changed', () => {
    const drafted = { name: 'Product', fields: [] };
    expect(draftSourceOf(drafted, { name: 'Product', fields: [] })).toBe('GENERATED');
    expect(draftSourceOf(drafted, { name: 'Item', fields: [] })).toBe('USER');
  });
});

describe('statusOfFilter and labelOf', () => {
  it('asks for every status for ALL, and names a value the table does not know by itself', () => {
    expect(statusOfFilter('ALL')).toBeUndefined();
    expect(statusOfFilter('PENDING')).toBe('PENDING');
    expect(labelOf(STATUS_LABELS, 'REJECTED')).toBe('Rejected');
    expect(labelOf<string>(STATUS_LABELS, 'ARCHIVED')).toBe('ARCHIVED');
  });
});
