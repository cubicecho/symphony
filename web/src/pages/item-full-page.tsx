import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LoadError } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from '@/components/ui/icons';
import { LayoutGrid } from '@/core/app-icons';
import { ModuleCard } from '@/modules/module-card';
import { assertModulePath, type ModuleRouter } from '@/modules/module-router';
import { splatOf, withItemPath } from '@/modules/module-url';
import { HOME_SLUG, type Page, usePages } from './use-pages.ts';

interface ItemFullPageProps {
  /** The page the item is placed on. */
  slug: string;
  /** The item. */
  itemId: string;
  /** The module's path, from the rest of the URL. */
  path: string;
}

/**
 * One placed module across the whole page, its path in this view's URL, with a way back to its page.
 */
export function ItemFullPage({ slug, itemId, path }: ItemFullPageProps) {
  const query = usePages();
  const router = useFullPageRouter(slug, itemId, path);

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
  const item = page?.items.find((candidate) => candidate.id === itemId);
  if (page === undefined || item === undefined) {
    return (
      <PageLayout
        title="Module not found"
        contentSlot={
          <EmptyState
            level={2}
            iconSlot={<LayoutGrid />}
            title="This module isn't on that page"
            description="It may have been removed from the page, or the link is old."
            actionSlot={<Button variant="outline" linkSlot={<Link to="/" />} content="Go home" />}
          />
        }
      />
    );
  }
  return (
    <PageLayout
      title={item.module.name}
      backSlot={
        <Button
          variant="ghost"
          size="sm"
          iconSlot={<ArrowLeft />}
          content={page.title}
          linkSlot={pageLinkOf(page, itemId, path)}
        />
      }
      contentSlot={<ModuleCard module={item.module} itemId={itemId} router={router} />}
    />
  );
}

/**
 * The router link back to a page, with the module still at the path it was on here. Home is `/`.
 *
 * @param page - The page.
 * @param itemId - The item.
 * @param path - The module's path, which the page keeps showing it at.
 * @returns A router link with no children, for a `linkSlot`.
 */
function pageLinkOf(page: Page, itemId: string, path: string) {
  const search = withItemPath({}, itemId, path);
  if (page.slug === HOME_SLUG) {
    return <Link to="/" search={search} />;
  }
  return <Link to="/pages/$slug" params={{ slug: page.slug }} search={search} />;
}

/**
 * The router of the full-page view: the module's path is the rest of this view's URL.
 *
 * @param slug - The page.
 * @param itemId - The item.
 * @param path - The module's path now.
 * @returns The router.
 */
function useFullPageRouter(slug: string, itemId: string, path: string): ModuleRouter {
  const navigate = useNavigate();
  const router = useRouter();
  return useMemo<ModuleRouter>(() => {
    const locationOf = (next: string) =>
      ({ to: '/pages/$slug/items/$itemId/$', params: { slug, itemId, _splat: splatOf(next) } }) as const;
    return {
      path,
      navigate: (next) => {
        assertModulePath(next);
        void navigate(locationOf(next));
      },
      hrefOf: (next) => router.buildLocation(locationOf(next)).href,
    };
  }, [slug, itemId, path, navigate, router]);
}
