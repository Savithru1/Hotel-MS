import { MAX_LINE_QUANTITY } from '@hospitality/constants';
import type { FoodOrderDto, MenuItemDto, RoomDto } from '@hospitality/shared-types';
import { useRef, useState } from 'react';
import {
  Async,
  Button,
  Dialog,
  ErrorNotice,
  SelectField,
  TextField,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';
import {
  cartEstimate,
  describeSelections,
  lineEstimate,
  missingRequired,
  toOrderItems,
  toggleSelection,
  type CartLine,
  type Selection,
} from './cart';

const sameSelections = (a: readonly Selection[], b: readonly Selection[]): boolean =>
  a.length === b.length &&
  a.every((x) => b.some((y) => y.group === x.group && y.choice === x.choice));

/** The options of one item, shown when it has any. Required groups must be chosen first. */
function OptionPicker({
  item,
  onAdd,
  onCancel,
}: {
  item: MenuItemDto;
  onAdd: (quantity: number, selections: Selection[], note: string) => void;
  onCancel: () => void;
}) {
  const [selections, setSelections] = useState<Selection[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const missing = missingRequired(item, selections);
  const chosen = (group: string, choice: string): boolean =>
    selections.some((selection) => selection.group === group && selection.choice === choice);

  return (
    <div
      role="group"
      aria-label={`Options for ${item.name}`}
      className="space-y-3 rounded-md bg-stone-50 p-3 ring-1 ring-stone-200"
    >
      {item.options.map((group) => (
        <fieldset key={group.name}>
          <legend className="text-sm font-medium text-slate-800">
            {group.name}
            {group.required ? ' (required)' : ''}
          </legend>
          <div className="mt-1 space-y-1">
            {!group.multiple && !group.required && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name={`group-${group.name}`}
                  checked={!selections.some((selection) => selection.group === group.name)}
                  onChange={() =>
                    setSelections(selections.filter((selection) => selection.group !== group.name))
                  }
                />
                None
              </label>
            )}
            {group.choices.map((choice) => {
              const text = `${choice.label}${choice.pricePaise > 0 ? ` +${money(choice.pricePaise)}` : ''}`;
              return (
                <label
                  key={choice.label}
                  className="flex items-center gap-2 text-sm text-slate-700"
                >
                  <input
                    type={group.multiple ? 'checkbox' : 'radio'}
                    name={`group-${group.name}`}
                    checked={chosen(group.name, choice.label)}
                    onChange={(event) =>
                      setSelections(
                        toggleSelection(
                          item,
                          selections,
                          group.name,
                          choice.label,
                          group.multiple ? event.target.checked : true,
                        ),
                      )
                    }
                  />
                  {text}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Quantity"
          type="number"
          min={1}
          max={MAX_LINE_QUANTITY}
          value={quantity}
          onChange={(event) => setQuantity(Number(event.target.value))}
        />
        <TextField
          label="Note for this item (optional)"
          value={note}
          maxLength={120}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {missing.length > 0 && (
        <p className="text-xs text-amber-800">Choose {missing.join(', ')} first.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" small onClick={onCancel}>
          Never mind
        </Button>
        <Button
          small
          disabled={
            missing.length > 0 ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > MAX_LINE_QUANTITY
          }
          onClick={() => onAdd(quantity, selections, note.trim())}
        >
          Add to order
        </Button>
      </div>
    </div>
  );
}

/** Front desk or kitchen places an order for the guest in a room. The server sets every price. */
export function NewFoodOrderDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const rooms = useList<RoomDto>('/rooms', { limit: 100 });
  const menu = useList<MenuItemDto>('/menu/items', { available: true, limit: 100 });
  const create = useSend<FoodOrderDto, object>('post', '/food-orders', ['/food-orders']);

  const [chosenRoom, setChosenRoom] = useState<string | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState<MenuItemDto | null>(null);
  const [notes, setNotes] = useState('');
  const lineKey = useRef(0);

  const occupied = rooms.items.filter((room) => room.status === 'occupied');
  // Until the person picks, the first room with a guest is selected.
  const roomId = chosenRoom ?? occupied[0]?.id ?? '';

  function addLine(
    item: MenuItemDto,
    quantity: number,
    selections: Selection[],
    note: string,
  ): void {
    setLines((current) => {
      const same = current.find(
        (line) =>
          line.item.id === item.id &&
          line.note === note &&
          sameSelections(line.selections, selections),
      );
      if (same) {
        return current.map((line) =>
          line === same
            ? { ...line, quantity: Math.min(MAX_LINE_QUANTITY, line.quantity + quantity) }
            : line,
        );
      }
      lineKey.current += 1;
      return [...current, { key: `line-${lineKey.current}`, item, quantity, selections, note }];
    });
    setPicking(null);
  }

  const categories = [...new Set(menu.items.map((item) => item.category))];

  return (
    <Dialog title="Place a food order" onClose={onClose}>
      <div className="space-y-4">
        <Async query={rooms}>
          <SelectField
            label="Room"
            value={roomId}
            onChange={(event) => setChosenRoom(event.target.value)}
          >
            {occupied.length === 0 && <option value="">No room has a guest checked in</option>}
            {occupied.map((room) => (
              <option key={room.id} value={room.id}>
                Room {room.number}
              </option>
            ))}
          </SelectField>
        </Async>

        <Async query={menu}>
          {menu.meta && menu.meta.total > menu.items.length && (
            <p className="text-xs text-amber-800">
              Showing the first {menu.items.length} of {menu.meta.total} menu items.
            </p>
          )}
          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {categories.map((category) => (
              <section key={category}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {category}
                </h3>
                <ul className="divide-y divide-stone-100">
                  {menu.items
                    .filter((item) => item.category === category)
                    .map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 py-1.5">
                        <div>
                          <p className="text-sm text-slate-900">{item.name}</p>
                          <p className="text-xs text-slate-500">{money(item.pricePaise)}</p>
                        </div>
                        <Button
                          variant="secondary"
                          small
                          aria-label={`Add ${item.name}`}
                          onClick={() =>
                            item.options.length > 0 ? setPicking(item) : addLine(item, 1, [], '')
                          }
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        </Async>

        {picking && (
          <OptionPicker
            key={picking.id}
            item={picking}
            onCancel={() => setPicking(null)}
            onAdd={(quantity, selections, note) => addLine(picking, quantity, selections, note)}
          />
        )}

        {lines.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-slate-800">This order</h3>
            <ul className="divide-y divide-stone-100">
              {lines.map((line) => (
                <li key={line.key} className="flex items-start justify-between gap-3 py-1.5">
                  <div className="text-sm text-slate-800">
                    <span>
                      {line.quantity} × {line.item.name}
                    </span>
                    {line.selections.length > 0 && (
                      <span className="block text-xs text-slate-500">
                        {describeSelections(line.selections)}
                      </span>
                    )}
                    {line.note && (
                      <span className="block text-xs text-slate-500">Note: {line.note}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-700">
                      {money(lineEstimate(line.item, line.quantity, line.selections))}
                    </span>
                    <Button
                      variant="quiet"
                      small
                      aria-label={`Remove ${line.item.name}`}
                      onClick={() =>
                        setLines((current) => current.filter((l) => l.key !== line.key))
                      }
                    >
                      ✕
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm font-medium text-slate-900">
              Estimated total <strong>{money(cartEstimate(lines))}</strong>
            </p>
            <p className="text-xs text-slate-500">
              Only an estimate. The server prices the order from the menu and tax is added at
              billing.
            </p>
          </div>
        )}

        <TextField
          label="Note for the kitchen (optional)"
          value={notes}
          maxLength={300}
          onChange={(event) => setNotes(event.target.value)}
        />

        {create.isError && <ErrorNotice error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !roomId || lines.length === 0}
            onClick={() =>
              create.mutate(
                { roomId, items: toOrderItems(lines), notes: notes.trim() },
                {
                  onSuccess: (created) => {
                    toast.success(`Order ${created.code} placed · ${money(created.subtotalPaise)}`);
                    onClose();
                  },
                },
              )
            }
          >
            Place order
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
