import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Ellipsis, Trash2 } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { messageOf } from '@/lib/error-message';
import { type Page, useDeletePage } from './use-pages.ts';

interface PageMenuProps {
  /** The page, never Home: Home can't be deleted. */
  page: Page;
  /** Told what went wrong when the server refuses. */
  onProblem: (problem: string) => void;
}

/** The ⋯ menu in a page's header: deleting the page. */
export function PageMenu({ page, onProblem }: PageMenuProps) {
  const navigate = useNavigate();
  const deletePage = useDeletePage();
  const [isConfirming, setIsConfirming] = useState(false);

  /** Deletes the page and goes home, or says why not. */
  const remove = (): void => {
    deletePage.mutate(page.slug, {
      onSuccess: () => void navigate({ to: '/' }),
      onError: (error) => onProblem(`Couldn't delete ${page.title}. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label={`Actions for ${page.title}`} iconSlot={<Ellipsis />} />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem iconSlot={<Trash2 />} label="Delete page" destructive onSelect={() => setIsConfirming(true)} />
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={isConfirming}
        onOpenChange={setIsConfirming}
        title={`Delete ${page.title}?`}
        description="The page and its places go. The modules on it are kept, and can be placed elsewhere."
        confirmLabel="Delete page"
        onConfirm={remove}
      />
    </>
  );
}
