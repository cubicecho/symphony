import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { Check, Pencil, Plus } from '@/components/ui/icons';
import { House, LayoutGrid } from '@/core/app-icons';
import { ProblemAlert } from '@/core/problem-alert';
import { AddModuleDialog } from './add-module-dialog.tsx';
import { PageGrid } from './page-grid.tsx';
import { PageMenu } from './page-menu.tsx';
import { HOME_SLUG, usePages } from './use-pages.ts';

interface PageViewProps {
  /** The page to show. */
  slug: string;
}

/** One page: its title, an edit mode for arranging it, and its modules in a grid. */
export function PageView({ slug }: PageViewProps) {
  const query = usePages();
  const [isEditing, setIsEditing] = useState(false);
  const [addSession, setAddSession] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (query.isError) {
    return (
      <PageLayout
        title="Symphony"
        contentSlot={<LoadError error={query.error} onRetry={query.refetch} what="your pages" />}
      />
    );
  }
  if (query.isPending) {
    return <PageLayout title="" loading contentSlot={null} />;
  }

  const page = query.data.find((candidate) => candidate.slug === slug);
  if (page === undefined) {
    return (
      <PageLayout
        title="Page not found"
        contentSlot={
          <EmptyState
            level={2}
            iconSlot={<LayoutGrid />}
            title="There is no page here"
            description="It may have been deleted, or the link has a typo."
            actionSlot={<Button variant="outline" linkSlot={<Link to="/" />} content="Go home" />}
          />
        }
      />
    );
  }

  const isHome = page.slug === HOME_SLUG;
  const hasItems = page.items.length > 0;
  /** Opens a fresh add-module dialog. */
  const startAdding = (): void => setAddSession((count) => (count ?? 0) + 1);
  const editLabel = isEditing ? 'Done arranging' : 'Arrange this page';

  return (
    <>
      <PageLayout
        title={page.title}
        iconSlot={isHome ? <House /> : <LayoutGrid />}
        actionSlot={
          <>
            {isEditing ? (
              <Button size="sm" variant="info" iconSlot={<Plus />} content="Add module" onClick={startAdding} />
            ) : null}
            <Button
              size="sm"
              variant={isEditing ? 'info' : 'outline'}
              aria-pressed={isEditing}
              aria-label={editLabel}
              iconSlot={isEditing ? <Check /> : <Pencil />}
              content={isEditing ? 'Done' : 'Edit'}
              onClick={() => setIsEditing(isEditing === false)}
            />
            {isHome ? null : <PageMenu page={page} onProblem={setProblem} />}
          </>
        }
        contentSlot={
          <>
            <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} />
            {hasItems ? (
              <PageGrid page={page} isEditing={isEditing} onProblem={setProblem} />
            ) : (
              <EmptyState
                iconSlot={<LayoutGrid />}
                title="Nothing on this page yet"
                description="Place a module that compiles here. Modules are written in the editor, or submitted by an agent over MCP."
                actionSlot={<Button variant="info" iconSlot={<Plus />} content="Add module" onClick={startAdding} />}
              />
            )}
          </>
        }
      />
      {addSession === null ? null : (
        <AddModuleDialog
          key={addSession}
          open
          onOpenChange={(isOpen) => {
            if (isOpen === false) {
              setAddSession(null);
            }
          }}
          page={page}
        />
      )}
    </>
  );
}
