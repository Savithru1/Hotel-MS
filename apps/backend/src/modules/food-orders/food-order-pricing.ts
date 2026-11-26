import { badRequest } from '../../shared/errors';
import type { MenuItemDocument } from '../menu/menu-item.model';
import type { FoodOrderLineDocument, FoodOrderOptionDocument } from './food-order.model';

export interface OrderLineInput {
  menuItemId: string;
  quantity: number;
  selections: { group: string; choice: string }[];
  note: string;
}

/** Option and group names match without caring about case or stray spaces. */
const key = (text: string): string => text.trim().toLowerCase();

const invalid = (message: string) => badRequest(message, 'invalid_selection');

/**
 * Prices one order line from the menu item, never from anything the client sent. The client only
 * names the item, the quantity and which options it wants; the name, the price and the price of
 * every option are read from the menu here and copied onto the line.
 *
 * Throws `invalid_selection` for an option that does not exist, a choice picked twice, more than
 * one choice in a pick-one group, or a required group left empty.
 */
export function priceLine(item: MenuItemDocument, input: OrderLineInput): FoodOrderLineDocument {
  // For each group, the indexes of the choices picked.
  const picked = new Map<number, Set<number>>();

  for (const selection of input.selections) {
    const groupIndex = item.options.findIndex((group) => key(group.name) === key(selection.group));
    const group = item.options[groupIndex];
    if (!group) throw invalid(`"${item.name}" has no option called "${selection.group}"`);

    const choiceIndex = group.choices.findIndex(
      (choice) => key(choice.label) === key(selection.choice),
    );
    if (choiceIndex < 0) {
      throw invalid(`${group.name} for "${item.name}" has no choice called "${selection.choice}"`);
    }

    const choices = picked.get(groupIndex) ?? new Set<number>();
    if (choices.has(choiceIndex)) {
      throw invalid(`"${selection.choice}" was chosen twice for "${item.name}"`);
    }
    choices.add(choiceIndex);
    picked.set(groupIndex, choices);
  }

  // Walk the menu's own groups so the options always come out in the same order on the ticket.
  const options: FoodOrderOptionDocument[] = [];
  for (const [groupIndex, group] of item.options.entries()) {
    const choices = picked.get(groupIndex);
    if (!choices || choices.size === 0) {
      if (group.required) throw invalid(`Please choose ${group.name} for "${item.name}"`);
      continue;
    }
    if (!group.multiple && choices.size > 1) {
      throw invalid(`Only one ${group.name} can be chosen for "${item.name}"`);
    }
    for (const [choiceIndex, choice] of group.choices.entries()) {
      if (choices.has(choiceIndex)) {
        options.push({ group: group.name, label: choice.label, pricePaise: choice.pricePaise });
      }
    }
  }

  const extras = options.reduce((sum, option) => sum + option.pricePaise, 0);
  return {
    menuItemId: item._id,
    name: item.name,
    quantity: input.quantity,
    unitPricePaise: item.pricePaise,
    options,
    note: input.note,
    lineTotalPaise: (item.pricePaise + extras) * input.quantity,
  };
}
