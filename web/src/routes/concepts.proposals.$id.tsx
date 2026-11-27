import { createFileRoute, Link } from '@tanstack/react-router';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { ProposalReview } from '@/concepts/proposal-review';
import { useConceptProposal } from '@/concepts/use-concept-proposals';

export const Route = createFileRoute('/concepts/proposals/$id')({ component: ProposalRoute });

/** One proposal's review screen, once it has loaded. */
function ProposalRoute() {
  const { id } = Route.useParams();
  const query = useConceptProposal(id);
  const proposal = query.data;
  if (proposal === undefined || proposal === null) {
    return (
      <PageLayout
        title={query.isPending ? '' : 'Proposal'}
        loading={query.isPending}
        contentSlot={
          <LoadState
            query={query}
            what="this proposal"
            record={proposal}
            notFoundLabel="Proposal not found"
            level={2}
            description="The link may be old."
            actionSlot={<Button variant="outline" linkSlot={<Link to="/concepts" />} content="Back to concepts" />}
          />
        }
      />
    );
  }
  return <ProposalReview key={proposal.id} proposal={proposal} />;
}
