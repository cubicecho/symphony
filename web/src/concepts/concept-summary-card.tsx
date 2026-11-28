import { CardLayout } from '@/components/card-layout';
import { Collapsible } from '@/components/collapsible';
import { EmptyState } from '@/components/empty-state';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { CodeBlock } from '@/components/ui/code';
import { formatCount } from '@/lib/format';
import { ConceptProblemList } from './concept-problem-list.tsx';
import { CONCEPT_OPERATIONS, type ConceptProblem, type ConceptSummary, problemsAt } from './concept-summary.ts';

interface ConceptSummaryCardProps {
  summary: ConceptSummary;
  /** The problems to place beside the members and documents they are about. */
  problems: readonly ConceptProblem[];
}

/**
 * Names a member's part in the concept.
 *
 * @param owned - The fields it owns.
 * @param problemCount - How many problems are placed in it.
 * @returns "Owns plan · 2 problems", or undefined when there is nothing to say.
 */
function memberLine(owned: readonly string[], problemCount: number): string | undefined {
  const parts = [
    owned.length === 0 ? null : `Owns ${owned.join(', ')}`,
    problemCount === 0 ? null : formatCount(problemCount, 'problem'),
  ].filter((part) => part !== null);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * What a concept definition says, in a card: its shared and owned fields, and each member's documents with the
 * problems placed in them.
 */
export function ConceptSummaryCard({ summary, problems }: ConceptSummaryCardProps) {
  return (
    <CardLayout
      title="Summary"
      description="Read from the definition as you type. Problems from the last check sit under the document they are in."
      contentSlot={<ConceptSummaryContent summary={summary} problems={problems} />}
    />
  );
}

/**
 * What a concept definition says, without a card round it: for a screen that already frames the concept.
 */
export function ConceptSummaryContent({ summary, problems }: ConceptSummaryCardProps) {
  return (
    <div className="grid gap-6">
      <Section
        level={3}
        title="Fields"
        contentSlot={
          summary.shared.length + summary.owned.length === 0 ? (
            <EmptyState compact title="No fields yet." />
          ) : (
            <div className="flex flex-wrap gap-1">
              {summary.shared.map((field) => (
                <Badge key={`shared:${field.name}`} variant="info-soft">
                  {field.name} · shared
                </Badge>
              ))}
              {summary.owned.map((field) => (
                <Badge key={`owned:${field.name}`}>
                  {field.name} · {field.owner === '' ? 'no owner' : `owned by ${field.owner}`}
                </Badge>
              ))}
            </div>
          )
        }
      />
      <Section
        level={3}
        title="Members"
        contentSlot={
          summary.members.length === 0 ? (
            <EmptyState compact title="No members yet." />
          ) : (
            <div className="grid gap-3">
              {summary.members.map((member, index) => {
                const memberProblems = problems.filter((problem) => problem.member === member.upstream);
                const looseProblems = problemsAt(problems, member.upstream, null);
                return (
                  <Collapsible
                    // Two members may share an upstream in a draft; the server says so as a problem.
                    // biome-ignore lint/suspicious/noArrayIndexKey: members are listed in definition order.
                    key={`${member.upstream}:${index}`}
                    title={member.upstream}
                    titleClassName="text-foreground"
                    description={memberLine(member.owned, memberProblems.length)}
                    defaultOpen={memberProblems.length > 0}
                    contentClassName="grid gap-3 pt-2"
                    contentSlot={
                      <>
                        {looseProblems.length === 0 ? null : (
                          <ConceptProblemList
                            problems={looseProblems}
                            label={`Problems with ${member.upstream}`}
                            placed
                          />
                        )}
                        {CONCEPT_OPERATIONS.map((operation) => {
                          const document = member.documents.find((one) => one.operation === operation);
                          const documentProblems = problemsAt(problems, member.upstream, operation);
                          return (
                            <div key={operation} className="grid gap-1">
                              {document === undefined ? (
                                <EmptyState compact title={`No ${operation} document.`} />
                              ) : (
                                <CodeBlock
                                  content={document.text}
                                  language="graphql"
                                  title={operation}
                                  maxHeight="md"
                                />
                              )}
                              {documentProblems.length === 0 ? null : (
                                <ConceptProblemList
                                  problems={documentProblems}
                                  label={`Problems in ${member.upstream}'s ${operation} document`}
                                  placed
                                />
                              )}
                            </div>
                          );
                        })}
                      </>
                    }
                  />
                );
              })}
            </div>
          )
        }
      />
    </div>
  );
}
