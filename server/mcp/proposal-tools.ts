// The tools that draft concepts from the upstreams and submit them as proposals. Accepting one is a person's step.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ConceptProposalRecord, ProposalSource, type Services } from '../core/services.ts';
import { jsonResult } from './answers.ts';
import { guard } from './tool-kit.ts';

/** How to get a smaller proposal answer. */
const NARROW_PROPOSALS = 'Pass `upstreams` to propose from fewer upstreams at a time.';

/** The sources an agent may say a submitted definition came from. */
const AGENT_SOURCES = [ProposalSource.Agent, ProposalSource.Generated] as const;

/**
 * Shapes a stored proposal for an answer, with what to do next.
 *
 * @param proposal - The proposal.
 * @returns Its id, status, whether it passes, its problems, and the next step.
 */
function proposalAnswer(proposal: ConceptProposalRecord) {
  const ok = proposal.problems.length === 0;
  const next = ok
    ? 'It passes. A person accepts or rejects it in Symphony; accepting saves it as a concept.'
    : `Fix the problems and call \`submit_concept\` again with id "${proposal.id}" and the whole definition.`;
  return {
    id: proposal.id,
    name: proposal.name,
    status: proposal.status,
    ok,
    problems: proposal.problems,
    next,
  };
}

/**
 * Registers propose_concepts and submit_concept.
 *
 * @param server - The MCP server.
 * @param services - The shared services.
 */
export function registerProposalTools(server: McpServer, services: Services): void {
  server.registerTool(
    'propose_concepts',
    {
      title: 'Propose concepts',
      description:
        "Drafts concepts from the upstreams' cached schemas: object types in two or more upstreams whose names match once a prefix or suffix is removed, each with `id: ID!` and a Query lookup by id. Each draft has its definition (a member document that could not be written with confidence is left out), plain-language `reasons` with a confidence, and the concept validator's `problems`. `notReady` lists candidates that lack an id or a lookup. Nothing is stored: refine a draft and `submit_concept` it.",
      inputSchema: {
        upstreams: z
          .array(z.string().min(1))
          .optional()
          .describe('Only these upstreams, by name. Left out for every upstream with a cached schema.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard('propose_concepts', async ({ upstreams }) =>
      jsonResult(await services.conceptProposals.propose(upstreams), NARROW_PROPOSALS),
    ),
  );

  server.registerTool(
    'submit_concept',
    {
      title: 'Submit a concept proposal',
      description:
        "Checks a concept definition against its members' cached schemas and stores it as a pending proposal, problems and all, so pass the returned `id` on every resubmit to revise the same proposal. When `ok` is true a person can accept it in Symphony, which saves it as a concept; agents can't accept.",
      inputSchema: {
        definition: z
          .record(z.string(), z.unknown())
          .describe(
            'The concept as JSON: its name, fields and members, each member with its four documents (fetch, create, update, delete).',
          ),
        id: z
          .string()
          .min(1)
          .optional()
          .describe('The id from an earlier submit, to revise that proposal. Left out to make a new one.'),
        note: z.string().optional().describe('A line for the person deciding: what it merges and anything unsure.'),
        source: z
          .enum(AGENT_SOURCES)
          .optional()
          .describe('`generated` when it is a `propose_concepts` draft submitted unchanged; `agent` otherwise.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard('submit_concept', async ({ definition, id, note, source }) => {
      const proposal = await services.conceptProposals.submit({
        definition,
        source: source ?? ProposalSource.Agent,
        ...(id === undefined ? {} : { id }),
        ...(note === undefined ? {} : { note }),
      });
      return jsonResult(proposalAnswer(proposal), 'Fix the problems listed first, then resubmit.');
    }),
  );
}
