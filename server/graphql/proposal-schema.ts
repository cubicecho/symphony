// The admin API's concept proposals: drafting concepts from the upstreams, and the pending proposals a person
// accepts or rejects. Kept apart from type-defs.ts and merged into the schema by buildSchema.
import { type ConceptDraft, Confidence } from '../concepts/propose.ts';
import {
  type ConceptProposalRecord,
  ProposalSource,
  ProposalStatus,
  type ProposedConcept,
  type Services,
} from '../core/services.ts';

/** The proposal types, and their fields on Query and Mutation. */
export const PROPOSAL_TYPE_DEFS = /* GraphQL */ `
  enum ConceptProposalStatus {
    "Waiting for a person to accept or reject it."
    PENDING
    "Saved as a concept."
    ACCEPTED
    REJECTED
  }

  "Who drafted a proposal."
  enum ConceptProposalSource {
    "Symphony's proposer, from the upstreams' schemas."
    GENERATED
    "An agent, over MCP."
    AGENT
    "A person, in the web app."
    USER
  }

  "How sure the proposer is of one decision."
  enum ProposalConfidence {
    "The schemas say so outright."
    HIGH
    "A good guess a person should glance at."
    MEDIUM
    "A fallback that probably needs changing by hand."
    LOW
  }

  "Why the proposer decided one thing."
  type ProposalReason {
    "What it is about: the concept's name, field <name>, member <upstream>, or <upstream> <operation>."
    about: String!
    reason: String!
    confidence: ProposalConfidence!
  }

  "A concept the proposer drafted. A document it could not write with confidence is left out of its member."
  type ConceptDraft {
    name: String!
    "The draft definition: submit it, edited or not, with submitConceptProposal."
    definition: JSON!
    "True when the concept validator finds nothing, so it could be accepted as it is."
    servable: Boolean!
    problems: [ConceptProblem!]!
    reasons: [ProposalReason!]!
  }

  "A type that looks like part of a shared entity but can't be a member yet."
  type NotReadyType {
    upstream: String!
    type: String!
    reason: String!
  }

  "A candidate concept with fewer than two members ready: each needs id: ID! and a lookup by id."
  type NotReadyConcept {
    name: String!
    types: [NotReadyType!]!
  }

  type ConceptProposals {
    drafts: [ConceptDraft!]!
    notReady: [NotReadyConcept!]!
  }

  "A concept someone proposed. A person accepts it as a concept, or rejects it."
  type ConceptProposal {
    id: ID!
    "The definition's name; empty when it has none."
    name: String!
    "The definition as it was submitted."
    definition: JSON!
    status: ConceptProposalStatus!
    source: ConceptProposalSource!
    "True when its last check found no problems, so it can be accepted."
    servable: Boolean!
    "What its last submit, or a refused accept, found."
    problems: [ConceptProblem!]!
    "What the submitter said about it."
    note: String
    "Why it was rejected."
    reason: String
    "The concept accepting it saved; null until then, or once that concept is removed."
    concept: Concept
    "ISO 8601."
    createdAt: String!
    "ISO 8601."
    updatedAt: String!
  }

  extend type Query {
    "Drafts concepts from the upstreams' cached schemas, without storing anything. Every upstream with a cached schema when upstreams is left out."
    proposeConcepts(upstreams: [String!]): ConceptProposals!
    "Every proposal, newest first, or only those with one status."
    conceptProposals(status: ConceptProposalStatus): [ConceptProposal!]!
    conceptProposal(id: ID!): ConceptProposal
  }

  extend type Mutation {
    "Checks a definition and stores it as a pending proposal, problems and all. Pass a pending proposal's id to revise it. The source is USER when left out."
    submitConceptProposal(
      definition: JSON!
      id: ID
      note: String
      source: ConceptProposalSource
    ): ConceptProposal!
    "Saves a pending proposal as a concept, which recomposes the unified API, and marks it accepted. Refused with BAD_USER_INPUT and extensions.problems when the concept does not fit."
    acceptConceptProposal(id: ID!): ConceptProposal!
    rejectConceptProposal(id: ID!, reason: String): ConceptProposal!
  }
`;

/**
 * Adds the proposal resolvers to the admin API's own, for createSchema to merge.
 *
 * @typeParam R - The admin resolvers' type.
 * @param resolvers - The admin API's resolvers.
 * @returns Both resolver maps.
 */
export function withProposalResolvers<R extends object>(resolvers: R): [R, ReturnType<typeof proposalResolvers>] {
  return [resolvers, proposalResolvers()];
}

/**
 * Builds the proposal resolvers.
 *
 * @returns Resolvers for the types and root fields in PROPOSAL_TYPE_DEFS.
 */
function proposalResolvers() {
  return {
    Query: {
      proposeConcepts: (_: unknown, args: { upstreams?: string[] | null }, ctx: Services) =>
        ctx.conceptProposals.propose(args.upstreams ?? undefined),
      conceptProposals: (_: unknown, args: { status?: ProposalStatus | null }, ctx: Services) =>
        ctx.conceptProposals.list(args.status ?? undefined),
      conceptProposal: (_: unknown, args: { id: string }, ctx: Services) => ctx.conceptProposals.find(args.id),
    },
    Mutation: {
      submitConceptProposal: (
        _: unknown,
        args: { definition: unknown; id?: string | null; note?: string | null; source?: ProposalSource | null },
        ctx: Services,
      ) =>
        ctx.conceptProposals.submit({
          definition: args.definition,
          source: args.source ?? ProposalSource.User,
          ...(args.id == null ? {} : { id: args.id }),
          ...(args.note == null ? {} : { note: args.note }),
        }),
      acceptConceptProposal: (_: unknown, args: { id: string }, ctx: Services) => ctx.conceptProposals.accept(args.id),
      rejectConceptProposal: (_: unknown, args: { id: string; reason?: string | null }, ctx: Services) =>
        ctx.conceptProposals.reject(args.id, args.reason ?? undefined),
    },
    ConceptProposalStatus: {
      PENDING: ProposalStatus.Pending,
      ACCEPTED: ProposalStatus.Accepted,
      REJECTED: ProposalStatus.Rejected,
    },
    ConceptProposalSource: {
      GENERATED: ProposalSource.Generated,
      AGENT: ProposalSource.Agent,
      USER: ProposalSource.User,
    },
    ProposalConfidence: { HIGH: Confidence.High, MEDIUM: Confidence.Medium, LOW: Confidence.Low },
    ConceptDraft: {
      name: (draft: ConceptDraft) => draft.definition.name,
      servable: (draft: ProposedConcept) => draft.problems.length === 0,
    },
    ConceptProposal: {
      servable: (proposal: ConceptProposalRecord) => proposal.problems.length === 0,
      concept: (proposal: ConceptProposalRecord, _args: unknown, ctx: Services) =>
        proposal.conceptId === null ? null : ctx.concepts.find(proposal.conceptId),
      createdAt: (proposal: ConceptProposalRecord) => proposal.createdAt.toISOString(),
      updatedAt: (proposal: ConceptProposalRecord) => proposal.updatedAt.toISOString(),
    },
  };
}
