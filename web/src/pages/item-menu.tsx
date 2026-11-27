import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Ellipsis, Trash2 } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { ArrowDown, ArrowUp, Columns3, Maximize2 } from '@/core/app-icons';
import { messageOf } from '@/lib/error-message';
import { widthLabel } from './column-span.ts';
import { fullPageLinkOf } from './full-page-link.tsx';
import { ItemWidthDialog } from './item-width-dialog.tsx';
import { type Item, type Page, useMoveItem, useRemoveItem } from './use-pages.ts';

interface ItemMenuProps {
  page: Page;
  item: Item;
  /** Where the item is on its page, from 0. */
  index: number;
  /** Told what went wrong when the server refuses a move or a removal. */
  onProblem: (problem: string) => void;
}

/** The ⋯ menu on an item in edit mode: open it full page, its width, move earlier or later, remove. */
export function ItemMenu({ page, item, index, onProblem }: ItemMenuProps) {
  // The page's search params hold the module's path, which the full-page view opens at.
  const search: Record<string, unknown> = useSearch({ strict: false });
  const moveItem = useMoveItem();
  const removeItem = useRemoveItem();
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const [widthSession, setWidthSession] = useState<number | null>(null);
  const name = item.module.name;
  const isFirst = index === 0;
  const isLast = index === page.items.length - 1;

  /**
   * Moves the item one place, and says so when the server refuses.
   *
   * @param offset - -1 for earlier, 1 for later.
   */
  const move = (offset: number): void => {
    moveItem.mutate(
      { id: item.id, offset },
      { onError: (error) => onProblem(`Couldn't move ${name}. ${messageOf(error) ?? ''}`.trim()) },
    );
  };

  /** Takes the item off the page, and says so when the server refuses. */
  const remove = (): void => {
    removeItem.mutate(item.id, {
      onError: (error) => onProblem(`Couldn't remove ${name}. ${messageOf(error) ?? ''}`.trim()),
    });
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${name}`} iconSlot={<Ellipsis />} />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            iconSlot={<Maximize2 />}
            label="Open full page"
            linkSlot={fullPageLinkOf(page.slug, item.id, search)}
          />
          <MenuSeparator />
          <MenuItem
            iconSlot={<Columns3 />}
            label={`Width (${widthLabel(item).toLowerCase()})…`}
            onSelect={() => setWidthSession((count) => (count ?? 0) + 1)}
          />
          <MenuItem iconSlot={<ArrowUp />} label="Move earlier" disabled={isFirst} onSelect={() => move(-1)} />
          <MenuItem iconSlot={<ArrowDown />} label="Move later" disabled={isLast} onSelect={() => move(1)} />
          <MenuSeparator />
          <MenuItem iconSlot={<Trash2 />} label="Remove" destructive onSelect={() => setIsConfirmingRemove(true)} />
        </MenuContent>
      </Menu>
      {widthSession === null ? null : (
        <ItemWidthDialog
          key={widthSession}
          open
          onOpenChange={(isOpen) => {
            if (isOpen === false) {
              setWidthSession(null);
            }
          }}
          item={item}
        />
      )}
      <ConfirmDialog
        open={isConfirmingRemove}
        onOpenChange={setIsConfirmingRemove}
        title={`Remove ${name}?`}
        description={`It comes off ${page.title}. The module itself is kept, and can be placed again.`}
        confirmLabel="Remove"
        onConfirm={remove}
      />
    </>
  );
}
