import type { MenuItemDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { AuthImage } from '../../components/AuthImage';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  errorText,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';
import { MenuItemDialog } from './MenuItemDialog';

function RemoveItemDialog({ item, onClose }: { item: MenuItemDto; onClose: () => void }) {
  const toast = useToast();
  const remove = useSend<{ id: string }, void>('delete', `/menu/items/${item.id}`, ['/menu']);
  return (
    <Dialog title={`Remove ${item.name}?`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          It will disappear from the menu, along with its photo. Orders already placed keep their
          price and name.
        </p>
        {remove.isError && <ErrorNotice error={remove.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  toast.success(`Removed ${item.name}`);
                  onClose();
                },
              })
            }
          >
            Remove item
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function MenuRow({
  item,
  onEdit,
  onRemove,
}: {
  item: MenuItemDto;
  onEdit: (item: MenuItemDto) => void;
  onRemove: (item: MenuItemDto) => void;
}) {
  const toast = useToast();
  const toggle = useSend<MenuItemDto, { available: boolean }>('patch', `/menu/items/${item.id}`, [
    '/menu',
  ]);

  return (
    <li className="flex items-start gap-3 py-3">
      {item.hasImage ? (
        <AuthImage
          path={`/menu/items/${item.id}/image`}
          alt={item.name}
          version={item.updatedAt}
          className="h-16 w-16 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div aria-hidden="true" className="h-16 w-16 shrink-0 rounded-md bg-stone-100" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{item.name}</span>
          <span className="text-sm text-slate-700">{money(item.pricePaise)}</span>
          {!item.available && <Badge tone="warn">Sold out</Badge>}
        </div>
        {item.description && <p className="text-sm text-slate-600">{item.description}</p>}
        {item.options.length > 0 && (
          <p className="text-xs text-slate-500">
            Options: {item.options.map((group) => group.name).join(', ')}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          variant="secondary"
          small
          disabled={toggle.isPending}
          aria-label={item.available ? `Mark ${item.name} sold out` : `Mark ${item.name} available`}
          onClick={() =>
            toggle.mutate(
              { available: !item.available },
              { onError: (e) => toast.error(errorText(e)) },
            )
          }
        >
          {item.available ? 'Mark sold out' : 'Mark available'}
        </Button>
        <Button variant="quiet" small aria-label={`Edit ${item.name}`} onClick={() => onEdit(item)}>
          Edit
        </Button>
        <Button
          variant="quiet"
          small
          aria-label={`Remove ${item.name}`}
          onClick={() => onRemove(item)}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

/** The menu editor: managers add dishes, set prices and options, and mark things sold out. */
export function MenuPage() {
  const list = useList<MenuItemDto>('/menu/items', { limit: 100 });
  const [editing, setEditing] = useState<MenuItemDto | 'new' | null>(null);
  const [removing, setRemoving] = useState<MenuItemDto | null>(null);

  const categories = [...new Set(list.items.map((item) => item.category))];

  return (
    <div>
      <PageHeader
        title="Menu"
        subtitle="What the kitchen can be asked for. Prices are before tax."
        actions={<Button onClick={() => setEditing('new')}>Add menu item</Button>}
      />
      {list.meta && list.meta.total > list.items.length && (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          Showing the first {list.items.length} of {list.meta.total} items. The rest are not shown
          here yet.
        </p>
      )}
      <Async query={list}>
        {list.items.length === 0 ? (
          <EmptyState>The menu is empty. Add the first item.</EmptyState>
        ) : (
          <div className="space-y-6">
            {categories.map((category) => (
              <section key={category}>
                <h2 className="mb-1 border-b border-stone-200 pb-1 font-serif text-lg text-slate-900">
                  {category}
                </h2>
                <ul className="divide-y divide-stone-100">
                  {list.items
                    .filter((item) => item.category === category)
                    .map((item) => (
                      <MenuRow
                        key={item.id}
                        item={item}
                        onEdit={setEditing}
                        onRemove={setRemoving}
                      />
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Async>

      {editing && (
        <MenuItemDialog
          {...(editing === 'new' ? {} : { item: editing })}
          categories={categories}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && <RemoveItemDialog item={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}
