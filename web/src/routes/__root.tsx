import { createLink, createRootRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ErrorPage } from '@/components/error-page';
import { LoadState } from '@/components/load-state';
import { AppBarItem, Sidebar, SidebarItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import { Button } from '@/components/ui/button';
import { Ellipsis, Plus, Server } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { ThemePicker } from '@/components/ui/theme-picker';
import { useThemePreference } from '@/components/ui/theme-preference';
import { Blocks, House, LayoutGrid, Music } from '@/core/app-icons';
import { PageDialog } from '@/pages/page-dialog';
import { HOME_SLUG, type Page, usePages } from '@/pages/use-pages';

const SidebarLink = createLink(SidebarItem);
const BarLink = createLink(AppBarItem);
const MODULES_PATH = '/modules';
const UPSTREAMS_PATH = '/upstreams';
const NEW_PAGE_LABEL = 'Add page';

export const Route = createRootRoute({
  component: Shell,
  errorComponent: ({ error, reset }) => <ErrorPage error={error} reset={reset} />,
});

/**
 * The router link props for a page: Home is `/`, the rest are under `/pages`.
 *
 * @param page - The page.
 * @returns What `to` and `params` a link to it takes.
 */
function linkTo(page: Page) {
  return page.slug === HOME_SLUG
    ? ({ to: '/' } as const)
    : ({ to: '/pages/$slug', params: { slug: page.slug } } as const);
}

/**
 * The glyph a page's row wears.
 *
 * @param page - The page the row is for.
 * @returns A house for Home, a grid for the rest.
 */
function pageIcon(page: Page) {
  return page.slug === HOME_SLUG ? <House /> : <LayoutGrid />;
}

/**
 * The app's mark and name.
 *
 * @param props - How much room it has.
 * @param props.compact - Draw the mark alone, its name kept for screen readers: the phone bar has no room for it.
 * @returns The link home.
 */
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2 rounded-md px-2 py-1 font-semibold text-foreground text-sm">
      <Music className="size-4" aria-hidden />
      <span className={compact ? 'sr-only' : undefined}>Symphony</span>
    </Link>
  );
}

/**
 * The phone bar's overflow: every page and adding one, which the bar has no room for.
 *
 * @param props - What the menu offers.
 * @param props.pages - Every page.
 * @param props.onNewPage - Opens the new-page dialog.
 * @returns The More button and its menu.
 */
function BarMoreMenu({ pages, onNewPage }: { pages: readonly Page[]; onNewPage: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="More" iconSlot={<Ellipsis />} />
      </MenuTrigger>
      <MenuContent align="end">
        {pages.map((page) => (
          <MenuItem
            key={page.slug}
            iconSlot={pageIcon(page)}
            label={page.title}
            linkSlot={<Link {...linkTo(page)} />}
          />
        ))}
        <MenuSeparator />
        <MenuItem iconSlot={<Plus />} label={NEW_PAGE_LABEL} onSelect={onNewPage} />
      </MenuContent>
    </Menu>
  );
}

/**
 * The app shell: the pages, then Modules and Upstreams, in the sidebar beside whichever screen the route
 * draws; on a phone, a bar across the top instead.
 *
 * @remarks
 * The theme preference is applied here, once for every screen. The new-page dialog lives here because
 * both the sidebar and the phone bar open it.
 */
function Shell() {
  useThemePreference();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const query = usePages();
  const pages = query.data ?? [];
  const [createSession, setCreateSession] = useState<number | null>(null);
  const isModules = pathname.startsWith(MODULES_PATH);
  const isUpstreams = pathname.startsWith(UPSTREAMS_PATH);

  /**
   * Whether a page's row is the one showing.
   *
   * @param page - The page.
   * @returns True when the browser is on it.
   */
  const isCurrent = (page: Page): boolean =>
    page.slug === HOME_SLUG ? pathname === '/' : pathname === `/pages/${page.slug}`;

  /** Opens a fresh new-page dialog. */
  const startCreating = (): void => setCreateSession((count) => (count ?? 0) + 1);

  return (
    <>
      <SidebarLayout
        className="h-svh"
        sidebarPosition="start"
        sidebarWidth="auto"
        divider="none"
        sidebarHideBelow="md"
        brandSlot={<Brand compact />}
        navLabel="Main"
        navSlot={
          <>
            <BarLink to="/" label="Home" iconSlot={<House />} active={pathname === '/'} />
            <BarLink to={MODULES_PATH} label="Modules" iconSlot={<Blocks />} active={isModules} />
            <BarLink to={UPSTREAMS_PATH} label="Upstreams" iconSlot={<Server />} active={isUpstreams} />
          </>
        }
        actionSlot={<BarMoreMenu pages={pages} onNewPage={startCreating} />}
        sidebarSlot={
          <Sidebar
            label="Main"
            headerSlot={<Brand />}
            contentSlot={
              <>
                <SidebarSection
                  as="nav"
                  label="Pages"
                  title="Pages"
                  actionSlot={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      aria-label={NEW_PAGE_LABEL}
                      iconSlot={<Plus />}
                      onClick={startCreating}
                    />
                  }
                  status={
                    <LoadState
                      compact
                      query={query}
                      what="your pages"
                      count={pages.length}
                      emptySlot={<EmptyState compact title="No pages yet." className="px-2" />}
                    />
                  }
                  contentSlot={pages.map((page) => (
                    <SidebarLink
                      key={page.slug}
                      {...linkTo(page)}
                      label={page.title}
                      iconSlot={pageIcon(page)}
                      count={page.items.length === 0 ? undefined : page.items.length}
                      active={isCurrent(page)}
                    />
                  ))}
                />
                <SidebarSection
                  as="nav"
                  label="Build"
                  title="Build"
                  contentSlot={
                    <>
                      <SidebarLink to={MODULES_PATH} label="Modules" iconSlot={<Blocks />} active={isModules} />
                      <SidebarLink to={UPSTREAMS_PATH} label="Upstreams" iconSlot={<Server />} active={isUpstreams} />
                    </>
                  }
                />
              </>
            }
            footerSlot={<ThemePicker variant="compact" />}
          />
        }
        contentSlot={<Outlet />}
      />
      {createSession === null ? null : (
        <PageDialog
          key={createSession}
          open
          onOpenChange={(isOpen) => {
            if (isOpen === false) {
              setCreateSession(null);
            }
          }}
          onSaved={(page) => void navigate({ to: '/pages/$slug', params: { slug: page.slug } })}
        />
      )}
    </>
  );
}
