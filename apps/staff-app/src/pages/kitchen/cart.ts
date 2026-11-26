import type { MenuItemDto } from '@hospitality/shared-types';

export interface Selection {
  group: string;
  choice: string;
}

/** One line being built for a new order: a menu item, how many, and which options. */
export interface CartLine {
  key: string;
  item: MenuItemDto;
  quantity: number;
  selections: Selection[];
  note: string;
}

/**
 * Ticks or unticks one option. In a pick-one group choosing something replaces the old choice;
 * in an add-on group choices pile up. Always returns a new list.
 */
export function toggleSelection(
  item: MenuItemDto,
  selections: readonly Selection[],
  group: string,
  choice: string,
  on: boolean,
): Selection[] {
  const others = selections.filter((selection) => selection.group !== group);
  const sameGroup = selections.filter(
    (selection) => selection.group === group && selection.choice !== choice,
  );
  if (!on) return [...others, ...sameGroup];
  const multiple = item.options.find((option) => option.name === group)?.multiple ?? false;
  return multiple ? [...others, ...sameGroup, { group, choice }] : [...others, { group, choice }];
}

/** The names of required option groups that have no choice yet. */
export function missingRequired(item: MenuItemDto, selections: readonly Selection[]): string[] {
  return item.options
    .filter(
      (option) =>
        option.required && !selections.some((selection) => selection.group === option.name),
    )
    .map((option) => option.name);
}

function extraFor(item: MenuItemDto, selection: Selection): number {
  const group = item.options.find((option) => option.name === selection.group);
  return group?.choices.find((choice) => choice.label === selection.choice)?.pricePaise ?? 0;
}

/**
 * An estimate for the screen only. The server prices the order itself from the menu, and what it
 * returns is what counts. This just lets the person see roughly what they are about to place.
 */
export function lineEstimate(
  item: MenuItemDto,
  quantity: number,
  selections: readonly Selection[],
): number {
  const extras = selections.reduce((sum, selection) => sum + extraFor(item, selection), 0);
  return (item.pricePaise + extras) * quantity;
}

export function cartEstimate(lines: readonly CartLine[]): number {
  return lines.reduce(
    (sum, line) => sum + lineEstimate(line.item, line.quantity, line.selections),
    0,
  );
}

export function describeSelections(selections: readonly Selection[]): string {
  return selections.map((selection) => selection.choice).join(', ');
}

/** The order lines to send: ids, quantities and choices only. No price or name is ever sent. */
export function toOrderItems(lines: readonly CartLine[]): {
  menuItemId: string;
  quantity: number;
  selections: Selection[];
  note: string;
}[] {
  return lines.map((line) => ({
    menuItemId: line.item.id,
    quantity: line.quantity,
    selections: line.selections.map((selection) => ({ ...selection })),
    note: line.note,
  }));
}
