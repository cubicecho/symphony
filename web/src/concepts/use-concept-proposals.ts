import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AcceptConceptProposalDocument,
  type ConceptDraftFieldsFragment,
  ConceptProposalDocument,
  type ConceptProposalFieldsFragment,
  type ConceptProposalSource,
  ConceptProposalsDocument,
  ProposeConceptsDocument,
  type ProposeConceptsQuery,
  RejectConceptProposalDocument,
  SubmitConceptProposalDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { type ProposalFilter, statusOfFilter } from './concept-proposals.ts';
import { invalidateUnified, UNIFIED_KEY } from './use-concepts.ts';

/** A concept the proposer drafted, not stored. */
export type ConceptDraft = ConceptDraftFieldsFragment;

/** A candidate concept that can't be drafted yet, and why. */
export type NotReadyConcept = ProposeConceptsQuery['proposeConcepts']['notReady'][number];

/** A stored proposal. */
export type ConceptProposal = ConceptProposalFieldsFragment;

/** Proposals change with the concepts they become, so they sit under the unified key. */
const PROPOSALS_KEY = [...UNIFIED_KEY, 'proposals'] as const;
/**
 * Drafts are worked out on request from every chosen schema, so they sit apart from the unified key: saving a
 * proposal from the list should not draft everything again under the reader.
 */
const DRAFTS_KEY = ['concept-drafts'] as const;

/**
 * Concepts drafted from some upstreams' cached schemas. Nothing is stored.
 *
 * @param upstreams - The upstreams to draft from, or null until the reader asks.
 * @returns The query; it waits while upstreams is null.
 */
export function useConceptDrafts(upstreams: readonly string[] | null) {
  return useQuery({
    queryKey: [...DRAFTS_KEY, upstreams],
    queryFn: async () =>
      (await request(ProposeConceptsDocument, { upstreams: [...(upstreams ?? [])] })).proposeConcepts,
    enabled: upstreams !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The stored proposals, newest first.
 *
 * @param filter - One status, or ALL.
 * @returns The query.
 */
export function useConceptProposals(filter: ProposalFilter) {
  return useQuery({
    queryKey: [...PROPOSALS_KEY, 'list', filter],
    queryFn: async () => (await request(ConceptProposalsDocument, { status: statusOfFilter(filter) })).conceptProposals,
  });
}

/**
 * The cache key of one proposal.
 *
 * @param id - The proposal's id.
 * @returns The key.
 */
function proposalKey(id: string) {
  return [...PROPOSALS_KEY, 'one', id] as const;
}

/**
 * One proposal.
 *
 * @param id - Its id.
 * @returns The query; its data is null when there is no such proposal.
 */
export function useConceptProposal(id: string) {
  return useQuery({
    queryKey: proposalKey(id),
    queryFn: async () => (await request(ConceptProposalDocument, { id })).conceptProposal,
  });
}

/**
 * Puts a proposal the server sent back in the cache, and refreshes the lists and whatever accepting it changed.
 *
 * @param client - The query client.
 * @param proposal - The proposal as it is now.
 */
function storeProposal(client: QueryClient, proposal: ConceptProposal): void {
  client.setQueryData(proposalKey(proposal.id), proposal);
  invalidateUnified(client);
}

/** What submitting a proposal sends. */
export interface ProposalSubmission {
  definition: unknown;
  /** A pending proposal to revise; left out to store a new one. */
  id?: string | undefined;
  note?: string | undefined;
  source?: ConceptProposalSource | undefined;
}

/**
 * Checks a definition and stores it as a pending proposal, or as a revision of one. It is stored with whatever
 * problems it has.
 *
 * @returns The mutation.
 */
export function useSubmitConceptProposal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ definition, id, note, source }: ProposalSubmission) =>
      (await request(SubmitConceptProposalDocument, { definition, id, note, source })).submitConceptProposal,
    onSuccess: (proposal) => storeProposal(client, proposal),
  });
}

/**
 * Saves a pending proposal as a concept. A refusal is a `RequestError` whose `extensions.problems` locates what is
 * wrong (`conceptProblemsOf`); the server stores those problems on the proposal, so it is fetched again either way.
 *
 * @returns The mutation, taking the proposal's id.
 */
export function useAcceptConceptProposal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(AcceptConceptProposalDocument, { id })).acceptConceptProposal,
    onSuccess: (proposal) => storeProposal(client, proposal),
    onError: () => invalidateUnified(client),
  });
}

/**
 * Rejects a pending proposal.
 *
 * @returns The mutation, taking the id and an optional reason.
 */
export function useRejectConceptProposal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string | undefined }) =>
      (await request(RejectConceptProposalDocument, { id, reason })).rejectConceptProposal,
    onSuccess: (proposal) => storeProposal(client, proposal),
  });
}
