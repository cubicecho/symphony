// Reading concept proposals and drafts for display: grouping the proposer's reasons, choosing which upstreams to
// draft from, and naming statuses and sources. Everything here is pure, so it is tested without a browser; the
// API's enums are spelled out rather than imported from the generated types, which the tests can't resolve.
import { CONCEPT_OPERATIONS } from './concept-summary.ts';

/** How sure the proposer is of one decision. */
export type ProposalConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Where a proposal stands. */
export type ConceptProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

/** Who drafted a proposal. */
export type ConceptProposalSource = 'GENERATED' | 'AGENT' | 'USER';

/** One decision the proposer explains, as the API sends it. */
export interface ProposalReason {
  /** The concept's name, `field <name>`, `member <upstream>`, or `<upstream> <operation>`. */
  about: string;
  reason: string;
  confidence: ProposalConfidence;
}

/** What part of a definition a reason is about. */
export type ReasonSubject = 'concept' | 'field' | 'member' | 'document';

/** The reasons about one part of a definition. */
export interface ReasonGroup {
  /** The `about` the reasons share. */
  about: string;
  subject: ReasonSubject;
  /** What the group is about, for a heading: "Field title", "shop · create". */
  label: string;
  reasons: ProposalReason[];
  /** The least sure of its reasons, which is what the group needs a glance for. */
  confidence: ProposalConfidence;
}

/** The order groups are listed in: the concept, then its fields, its members, and their documents. */
const SUBJECT_ORDER: readonly ReasonSubject[] = ['concept', 'field', 'member', 'document'];

/** The confidences from least to most sure. */
const CONFIDENCE_ORDER: readonly ProposalConfidence[] = ['LOW', 'MEDIUM', 'HIGH'];

const FIELD_PREFIX = 'field ';
const MEMBER_PREFIX = 'member ';

/**
 * Works out what part of a definition a reason's `about` names.
 *
 * @param about - The reason's `about`.
 * @returns The part, and its label for a heading.
 */
export function reasonSubjectOf(about: string): { subject: ReasonSubject; label: string } {
  if (about.startsWith(FIELD_PREFIX)) {
    return { subject: 'field', label: `Field ${about.slice(FIELD_PREFIX.length)}` };
  }
  if (about.startsWith(MEMBER_PREFIX)) {
    return { subject: 'member', label: `Member ${about.slice(MEMBER_PREFIX.length)}` };
  }
  const lastSpace = about.lastIndexOf(' ');
  const operation = about.slice(lastSpace + 1);
  const isDocument = lastSpace > 0 && CONCEPT_OPERATIONS.some((one) => one === operation);
  if (isDocument) {
    return { subject: 'document', label: `${about.slice(0, lastSpace)} · ${operation}` };
  }
  return { subject: 'concept', label: 'Concept' };
}

/**
 * Picks the least sure of some confidences.
 *
 * @param confidences - At least one confidence.
 * @returns The lowest; HIGH when the list is empty.
 */
export function lowestConfidence(confidences: readonly ProposalConfidence[]): ProposalConfidence {
  return CONFIDENCE_ORDER.find((confidence) => confidences.includes(confidence)) ?? 'HIGH';
}

/**
 * Groups a draft's reasons by what they are about: the concept first, then its fields, members and documents, each
 * in the order the proposer gave them.
 *
 * @param reasons - The draft's reasons.
 * @returns One group per `about`.
 */
export function groupReasons(reasons: readonly ProposalReason[]): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>();
  for (const reason of reasons) {
    const group = groups.get(reason.about);
    if (group === undefined) {
      groups.set(reason.about, {
        about: reason.about,
        ...reasonSubjectOf(reason.about),
        reasons: [reason],
        confidence: reason.confidence,
      });
    } else {
      group.reasons.push(reason);
      group.confidence = lowestConfidence([group.confidence, reason.confidence]);
    }
  }
  // Array.prototype.sort is stable, so groups of one subject keep the proposer's order.
  return [...groups.values()].sort((a, b) => SUBJECT_ORDER.indexOf(a.subject) - SUBJECT_ORDER.indexOf(b.subject));
}

/**
 * Counts the reasons a person should check: the ones the proposer is not sure of.
 *
 * @param reasons - A draft's reasons.
 * @returns How many are MEDIUM or LOW.
 */
export function unsureReasonCount(reasons: readonly ProposalReason[]): number {
  return reasons.filter((reason) => reason.confidence !== 'HIGH').length;
}

/** An upstream, as far as choosing what to draft from needs it. */
export interface ProposableUpstream {
  name: string;
  /** The built-in unified API, which is made of concepts rather than a source of them. */
  builtIn: boolean;
  /** Null until its schema has been fetched. */
  schema: unknown;
}

/** The upstreams concepts can be drafted from. */
export interface UpstreamChoice {
  /** Stored upstreams with a cached schema, in the order given. */
  ready: string[];
  /** Stored upstreams whose schema has not been fetched, so there is nothing to draft from yet. */
  unfetched: string[];
}

/**
 * Sorts the stored upstreams into those concepts can be drafted from and those without a schema yet, leaving out the
 * built-in unified API.
 *
 * @param upstreams - Every upstream.
 * @returns Their names, split.
 */
export function upstreamChoiceOf(upstreams: readonly ProposableUpstream[]): UpstreamChoice {
  const stored = upstreams.filter((upstream) => upstream.builtIn === false);
  return {
    ready: stored.filter((upstream) => upstream.schema !== null).map((upstream) => upstream.name),
    unfetched: stored.filter((upstream) => upstream.schema === null).map((upstream) => upstream.name),
  };
}

/**
 * Turns one upstream on or off in a choice, keeping the order the upstreams are listed in.
 *
 * @param chosen - The upstreams chosen now.
 * @param upstream - The one pressed.
 * @param order - Every upstream that can be chosen, in display order.
 * @returns The new choice.
 */
export function toggleUpstream(chosen: readonly string[], upstream: string, order: readonly string[]): string[] {
  const isChosen = chosen.includes(upstream);
  return order.filter((name) => (name === upstream ? isChosen === false : chosen.includes(name)));
}

/**
 * Says who drafted a proposal saved from the propose screen: the proposer, unless a person changed its definition.
 *
 * @param drafted - The definition the proposer drafted.
 * @param saved - The definition being saved.
 * @returns GENERATED when they are the same JSON, USER otherwise.
 */
export function draftSourceOf(drafted: unknown, saved: unknown): ConceptProposalSource {
  return JSON.stringify(drafted) === JSON.stringify(saved) ? 'GENERATED' : 'USER';
}

/** A proposal status filter: one status, or every proposal. */
export type ProposalFilter = ConceptProposalStatus | 'ALL';

/** The filters in the order the list offers them. */
export const PROPOSAL_FILTERS: readonly ProposalFilter[] = ['PENDING', 'ACCEPTED', 'REJECTED', 'ALL'];

/**
 * The `status` argument a filter asks the API for.
 *
 * @param filter - The filter chosen.
 * @returns The status, or undefined for every proposal.
 */
export function statusOfFilter(filter: ProposalFilter): ConceptProposalStatus | undefined {
  return filter === 'ALL' ? undefined : filter;
}

/** What each filter and status is called on screen. */
export const STATUS_LABELS: Record<ProposalFilter, string> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  ALL: 'All',
};

/** What each source is called on screen. */
export const SOURCE_LABELS: Record<ConceptProposalSource, string> = {
  GENERATED: 'Generated',
  AGENT: 'Agent',
  USER: 'Person',
};

/** What each confidence is called on screen. */
export const CONFIDENCE_LABELS: Record<ProposalConfidence, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/**
 * Names a value from a lookup table, falling back to the value itself for one added to the API after this app.
 *
 * @param labels - The table.
 * @param value - The value.
 * @returns Its label.
 */
export function labelOf<T extends string>(labels: Readonly<Record<T, string>>, value: T): string {
  return labels[value] ?? value;
}
