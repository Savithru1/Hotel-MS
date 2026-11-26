import type { MenuItemDto } from '@hospitality/shared-types';
import type { MenuItemDocument } from './menu-item.model';

export function toMenuItemDto(item: MenuItemDocument): MenuItemDto {
  return {
    id: item._id.toHexString(),
    name: item.name,
    category: item.category,
    description: item.description,
    pricePaise: item.pricePaise,
    options: item.options.map((group) => ({
      name: group.name,
      required: group.required,
      multiple: group.multiple,
      choices: group.choices.map((choice) => ({
        label: choice.label,
        pricePaise: choice.pricePaise,
      })),
    })),
    available: item.available,
    hasImage: item.imageId !== null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
