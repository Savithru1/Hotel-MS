import type { Types } from 'mongoose';
import { runWithTenant } from '../../shared/request-context';
import { MenuItem } from '../menu/menu-item.model';

interface SeedMenuItem {
  name: string;
  category: string;
  description: string;
  /** Rupees, converted to paise when stored. */
  price: number;
  available?: boolean;
  options?: {
    name: string;
    required?: boolean;
    multiple?: boolean;
    choices: { label: string; extra?: number }[];
  }[];
}

/** DEVELOPMENT DATA ONLY: a small sample menu so the kitchen screens have something to show. */
const SEED_MENU: readonly SeedMenuItem[] = [
  {
    name: 'Paneer Butter Masala',
    category: 'Main course',
    description: 'Cottage cheese in a creamy tomato gravy',
    price: 320,
    options: [
      {
        name: 'Spice level',
        required: true,
        choices: [{ label: 'Mild' }, { label: 'Medium' }, { label: 'Hot' }],
      },
      {
        name: 'Add-ons',
        multiple: true,
        choices: [
          { label: 'Extra cheese', extra: 30 },
          { label: 'Butter naan', extra: 50 },
        ],
      },
    ],
  },
  {
    name: 'Dal Tadka',
    category: 'Main course',
    description: 'Yellow lentils tempered with garlic',
    price: 240,
  },
  {
    name: 'Veg Biryani',
    category: 'Main course',
    description: 'Basmati rice cooked with vegetables',
    price: 280,
  },
  {
    name: 'Masala Dosa',
    category: 'Breakfast',
    description: 'Crisp rice crepe with potato filling',
    price: 160,
  },
  { name: 'Masala Chai', category: 'Drinks', description: 'Spiced milk tea', price: 80 },
  {
    name: 'Fresh Lime Soda',
    category: 'Drinks',
    description: 'Sweet, salted or plain',
    price: 90,
    options: [
      {
        name: 'Taste',
        required: true,
        choices: [{ label: 'Sweet' }, { label: 'Salted' }, { label: 'Plain' }],
      },
      { name: 'Size', choices: [{ label: 'Regular' }, { label: 'Large', extra: 20 }] },
    ],
  },
  { name: 'Club Sandwich', category: 'Snacks', description: 'Toasted, with fries', price: 260 },
  { name: 'Gulab Jamun', category: 'Desserts', description: 'Two pieces, served warm', price: 120 },
  {
    name: 'Seasonal Fruit Platter',
    category: 'Desserts',
    description: 'Sold out today',
    price: 200,
    available: false,
  },
];

/**
 * Adds the sample menu to one property. Items that already exist (by name) are left alone, so it
 * is safe to run twice. Returns how many items were created.
 */
export async function seedDevelopmentMenu(propertyId: Types.ObjectId): Promise<number> {
  return runWithTenant(propertyId, async () => {
    let created = 0;
    for (const item of SEED_MENU) {
      const result = await MenuItem.updateOne(
        { nameKey: item.name.toLowerCase() },
        {
          $setOnInsert: {
            name: item.name,
            nameKey: item.name.toLowerCase(),
            category: item.category,
            description: item.description,
            pricePaise: item.price * 100,
            available: item.available ?? true,
            options: (item.options ?? []).map((group) => ({
              name: group.name,
              required: group.required ?? false,
              multiple: group.multiple ?? false,
              choices: group.choices.map((choice) => ({
                label: choice.label,
                pricePaise: (choice.extra ?? 0) * 100,
              })),
            })),
          },
        },
        { upsert: true },
      );
      created += result.upsertedCount;
    }
    return created;
  });
}
