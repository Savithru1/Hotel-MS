import {
  FOOD_ORDER_STATUSES,
  MAX_CHOICES_PER_GROUP,
  MAX_LINE_QUANTITY,
  MAX_MENU_PRICE_PAISE,
  MAX_OPTION_GROUPS,
  MAX_ORDER_LINES,
} from '@hospitality/constants';
import { z } from 'zod';
import { objectIdSchema, paginationSchema, shortText } from './common';

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const MAX_SELECTIONS_PER_LINE = 50;

/** Money in whole paise. Menu prices are at least one paisa; option extras may be free. */
const pricePaise = z.number().int().min(1).max(MAX_MENU_PRICE_PAISE);
const extraPaise = z.number().int().min(0).max(MAX_MENU_PRICE_PAISE);

const optionChoiceSchema = z.object({
  label: shortText(40),
  pricePaise: extraPaise.default(0),
});

const optionGroupSchema = z
  .object({
    name: shortText(40),
    /** The guest must pick something from this group. */
    required: z.boolean().default(false),
    /** More than one choice may be picked (add-ons). Otherwise exactly one at most. */
    multiple: z.boolean().default(false),
    choices: z.array(optionChoiceSchema).min(1).max(MAX_CHOICES_PER_GROUP),
  })
  .superRefine((group, context) => {
    const seen = new Set<string>();
    for (const [index, choice] of group.choices.entries()) {
      const key = choice.label.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'two choices have the same name',
          path: ['choices', index, 'label'],
        });
      }
      seen.add(key);
    }
  });

const optionsSchema = z
  .array(optionGroupSchema)
  .max(MAX_OPTION_GROUPS)
  .superRefine((groups, context) => {
    const seen = new Set<string>();
    for (const [index, group] of groups.entries()) {
      const key = group.name.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'two option groups have the same name',
          path: [index, 'name'],
        });
      }
      seen.add(key);
    }
  });

// Menu ---------------------------------------------------------------------------------------

export const createMenuItemSchema = z.object({
  name: shortText(80),
  category: shortText(40),
  description: z.string().trim().max(300).default(''),
  pricePaise,
  options: optionsSchema.default([]),
  available: z.boolean().default(true),
});

/**
 * Written out field by field instead of derived from the create schema: a derived partial would
 * bring the create defaults along and silently reset fields the caller did not send.
 */
export const updateMenuItemSchema = z
  .object({
    name: shortText(80).optional(),
    category: shortText(40).optional(),
    description: z.string().trim().max(300).optional(),
    pricePaise: pricePaise.optional(),
    options: optionsSchema.optional(),
    available: z.boolean().optional(),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined), {
    message: 'send at least one field to change',
  });

export const listMenuQuerySchema = paginationSchema.extend({
  category: shortText(40).optional(),
  available: booleanQuery,
});

// Food orders --------------------------------------------------------------------------------

const orderLineSchema = z.object({
  menuItemId: objectIdSchema,
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  /** Chosen options by group and choice name. The server looks up the prices. */
  selections: z
    .array(z.object({ group: shortText(40), choice: shortText(40) }))
    .max(MAX_SELECTIONS_PER_LINE)
    .default([]),
  note: z.string().trim().max(120).default(''),
});

/** There is deliberately no price, name or total here: the server prices every order itself. */
export const createFoodOrderSchema = z.object({
  roomId: objectIdSchema,
  items: z.array(orderLineSchema).min(1).max(MAX_ORDER_LINES),
  notes: z.string().trim().max(300).default(''),
});

export const listFoodOrdersQuerySchema = paginationSchema.extend({
  status: z.enum(FOOD_ORDER_STATUSES).optional(),
  /** `open` = received, preparing or ready. */
  open: booleanQuery,
  roomId: objectIdSchema.optional(),
  bookingId: objectIdSchema.optional(),
});

export const cancelFoodOrderSchema = z.object({
  reason: z.string().trim().min(3, 'please give a reason').max(200),
});
