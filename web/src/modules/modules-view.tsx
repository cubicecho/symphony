import { Link } from '@tanstack/react-router';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { Blocks } from '@/core/app-icons';
import { McpNote } from './mcp-note.tsx';
import { ModuleStatusBadge } from './module-status-badge.tsx';
import { useModules } from './use-modules.ts';

/** The modules screen: every module, its upstream, whether it compiles, and its version. */
export function ModulesView() {
  const query = useModules();
  const modules = query.data ?? [];
  const newButton = (
    <Button size="sm" variant="info" iconSlot={<Plus />} content="New module" linkSlot={<Link to="/modules/new" />} />
  );

  return (
    <PageLayout
      title="Modules"
      description="React components over one upstream each. Place the ones that compile on a page."
      actionSlot={newButton}
      contentSlot={
        <>
          <McpNote />
          <LoadState
            query={query}
            what="your modules"
            count={modules.length}
            emptySlot={
              <EmptyState
                iconSlot={<Blocks />}
                title="No modules yet"
                description="Write one here, starting from an example, or have an agent submit one over MCP."
                actionSlot={newButton}
              />
            }
          />
          {modules.length === 0 ? null : (
            <List
              label="Modules"
              contentSlot={modules.map((module) => (
                <ListItem
                  key={module.id}
                  title={module.name}
                  description={
                    module.description === '' ? module.upstream.name : `${module.upstream.name} · ${module.description}`
                  }
                  meta={
                    <span className="flex items-center gap-2">
                      <ModuleStatusBadge status={module.status} />
                      <span className="text-foreground/60 text-xs">v{module.version}</span>
                    </span>
                  }
                  linkSlot={<Link to="/modules/$id" params={{ id: module.id }} />}
                />
              ))}
            />
          )}
        </>
      }
    />
  );
}
