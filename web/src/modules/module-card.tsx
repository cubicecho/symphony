import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode, useMemo } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { messageOf } from '@/lib/error-message';
import { loadModule } from './load-module.ts';
import { ModuleContext, type ModuleScope, moduleScopeOf } from './module-context.ts';
import { type ModuleRouter, ModuleRouterContext, useCardRouter } from './module-router.ts';

/** The module a card draws, as the pages and the editor both hold it. */
export interface ModuleCardModule {
  id: string;
  name: string;
  /** `READY` or `FAILED`. */
  status: string;
  /** Where its compiled code is; null while it does not compile. */
  codeUrl: string | null;
  /** Its upstreams, in order: the first is the default. */
  upstreams: {
    /** What `gql.from('<name>')` calls it. */
    name: string;
    /** Where it takes GraphQL documents. */
    proxyPath: string;
  }[];
}

interface ModuleCardProps {
  module: ModuleCardModule;
  /** The page item it is drawn for: its path is kept in the page URL. Left out (the editor's preview), in memory. */
  itemId?: string | undefined;
  /** Where its path is kept instead, as the full-page view keeps it in its own URL. */
  router?: ModuleRouter | undefined;
}

/**
 * One module, live: its compiled component loaded and drawn with its upstream's data. A module that
 * does not compile, fails to load or throws while drawing says so, by name, with a link to its editor.
 */
export function ModuleCard({ module, itemId, router }: ModuleCardProps) {
  const { codeUrl } = module;
  if (codeUrl === null) {
    return (
      <Alert
        variant="warning"
        title={`${module.name} doesn't compile`}
        description="Its last save had errors, so there is nothing to show until it is fixed."
        actionSlot={<EditorLink moduleId={module.id} />}
      />
    );
  }
  return <LoadedModule module={module} codeUrl={codeUrl} itemId={itemId} router={router} />;
}

interface LoadedModuleProps extends ModuleCardProps {
  /** The version's code, known to be there. */
  codeUrl: string;
}

/** Loads a compiled module and draws it inside its scope, its router and an error boundary. */
function LoadedModule({ module, codeUrl, itemId, router }: LoadedModuleProps) {
  const query = useQuery({
    queryKey: ['module-code', codeUrl],
    queryFn: () => loadModule(codeUrl),
    // A code URL names one version, so what it loaded never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const scope = useMemo<ModuleScope>(
    () => moduleScopeOf(module.id, module.upstreams, itemId),
    [module.id, module.upstreams, itemId],
  );
  const cardRouter = useCardRouter(scope.itemId);

  if (query.isPending) {
    return <Skeleton className="h-32 w-full rounded-lg" aria-label={`Loading ${module.name}`} />;
  }
  if (query.isError) {
    return <ModuleFailure module={module} message={messageOf(query.error) ?? 'It could not be loaded.'} />;
  }
  const Loaded = query.data;
  return (
    <ModuleErrorBoundary key={codeUrl} module={module}>
      <ModuleContext.Provider value={scope}>
        <ModuleRouterContext.Provider value={router ?? cardRouter}>
          <Loaded />
        </ModuleRouterContext.Provider>
      </ModuleContext.Provider>
    </ModuleErrorBoundary>
  );
}

/**
 * The way to a module's editor.
 *
 * @param props - Which module.
 * @param props.moduleId - Its id.
 * @returns An outline button linking to /modules/$id.
 */
function EditorLink({ moduleId }: { moduleId: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      content="Open in editor"
      linkSlot={<Link to="/modules/$id" params={{ id: moduleId }} />}
    />
  );
}

interface ModuleFailureProps {
  module: ModuleCardModule;
  /** What went wrong. */
  message: string;
}

/** What a module that failed to load or threw while drawing shows in its place. */
function ModuleFailure({ module, message }: ModuleFailureProps) {
  return (
    <Alert
      variant="destructive"
      title={`${module.name} failed`}
      description={message}
      actionSlot={<EditorLink moduleId={module.id} />}
    />
  );
}

interface ModuleErrorBoundaryProps {
  module: ModuleCardModule;
  /** The module's component, in its scope. React's error boundaries take their subject as children. */
  children: ReactNode;
}

interface ModuleErrorBoundaryState {
  /** What the module threw, or null while it draws. */
  error: unknown;
  hasFailed: boolean;
}

/**
 * Catches what a module throws while drawing, so one broken module leaves the rest of the page standing.
 *
 * @remarks
 * A class, because React only offers error boundaries as classes. It is keyed by code URL where it is
 * used, so a new version of the module starts without the old one's error.
 */
class ModuleErrorBoundary extends Component<ModuleErrorBoundaryProps, ModuleErrorBoundaryState> {
  state: ModuleErrorBoundaryState = { error: null, hasFailed: false };

  /**
   * Records the error so the next render draws the failure.
   *
   * @param error - What the module threw.
   * @returns The failed state.
   */
  static getDerivedStateFromError(error: unknown): ModuleErrorBoundaryState {
    return { error, hasFailed: true };
  }

  /**
   * Logs the failure with the module's name, for the console.
   *
   * @param error - What the module threw.
   * @param info - Where in the tree.
   */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`Module "${this.props.module.name}" threw while drawing.`, error, info.componentStack);
  }

  /**
   * Draws the module, or its failure.
   *
   * @returns The module's tree, or the failure message.
   */
  render(): ReactNode {
    if (this.state.hasFailed) {
      return <ModuleFailure module={this.props.module} message={messageOf(this.state.error) ?? 'It threw an error.'} />;
    }
    return this.props.children;
  }
}
