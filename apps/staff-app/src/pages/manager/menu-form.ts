import { MAX_MENU_PRICE_PAISE } from '@hospitality/constants';
import type { MenuItemDto } from '@hospitality/shared-types';

export interface MenuFormChoice {
  label: string;
  /** Extra charge in rupees as typed; empty means free. */
  extra: string;
}

export interface MenuFormGroup {
  name: string;
  required: boolean;
  multiple: boolean;
  choices: MenuFormChoice[];
}

/** The menu item form as typed, before it is checked. Prices are rupees in text. */
export interface MenuFormState {
  name: string;
  category: string;
  description: string;
  price: string;
  available: boolean;
  options: MenuFormGroup[];
}

/** The body the menu API takes. Prices are whole paise. */
export interface MenuPayload {
  name: string;
  category: string;
  description: string;
  pricePaise: number;
  available: boolean;
  options: {
    name: string;
    required: boolean;
    multiple: boolean;
    choices: { label: string; pricePaise: number }[];
  }[];
}

export type MenuPayloadResult = { ok: true; value: MenuPayload } | { ok: false; error: string };

/**
 * Reads an amount typed in rupees ("320", "320.5", "1,250") as whole paise. Done with string
 * arithmetic so 19.99 is exactly 1999, never 1998.999. Returns null for anything else.
 */
export function rupeesToPaise(text: string): number | null {
  const cleaned = text.trim().replaceAll(',', '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Whole rupees are shown plainly ("320"), anything else with two decimals ("320.50"). */
export function paiseToRupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const fraction = paise % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
}

export function emptyMenuForm(): MenuFormState {
  return { name: '', category: '', description: '', price: '', available: true, options: [] };
}

export function formFromItem(item: MenuItemDto): MenuFormState {
  return {
    name: item.name,
    category: item.category,
    description: item.description,
    price: paiseToRupees(item.pricePaise),
    available: item.available,
    options: item.options.map((group) => ({
      name: group.name,
      required: group.required,
      multiple: group.multiple,
      choices: group.choices.map((choice) => ({
        label: choice.label,
        extra: choice.pricePaise === 0 ? '' : paiseToRupees(choice.pricePaise),
      })),
    })),
  };
}

const fail = (error: string): MenuPayloadResult => ({ ok: false, error });

/** Checks the form and turns it into an API body, or says in plain words what to fix. */
export function buildMenuPayload(form: MenuFormState): MenuPayloadResult {
  const name = form.name.trim();
  const category = form.category.trim();
  if (!name) return fail('Enter a name for the item.');
  if (!category) return fail('Enter a category, for example Starters.');

  const pricePaise = rupeesToPaise(form.price);
  if (pricePaise === null || pricePaise < 1 || pricePaise > MAX_MENU_PRICE_PAISE) {
    return fail('Enter a price between 0.01 and 10,000 rupees, like 320 or 320.50.');
  }

  const options: MenuPayload['options'] = [];
  for (const group of form.options) {
    const groupName = group.name.trim();
    if (!groupName) return fail('Give every option group a name, for example "Spice level".');
    if (group.choices.length === 0) return fail(`Option group "${groupName}" needs a choice.`);

    const choices: MenuPayload['options'][number]['choices'] = [];
    for (const choice of group.choices) {
      const label = choice.label.trim();
      if (!label) return fail(`Every choice in "${groupName}" needs a name.`);
      const extra = choice.extra.trim() === '' ? 0 : rupeesToPaise(choice.extra);
      if (extra === null || extra > MAX_MENU_PRICE_PAISE) {
        return fail(`The extra price for "${label}" must be an amount like 30 or 30.50.`);
      }
      choices.push({ label, pricePaise: extra });
    }
    options.push({
      name: groupName,
      required: group.required,
      multiple: group.multiple,
      choices,
    });
  }

  return {
    ok: true,
    value: {
      name,
      category,
      description: form.description.trim(),
      pricePaise,
      available: form.available,
      options,
    },
  };
}
