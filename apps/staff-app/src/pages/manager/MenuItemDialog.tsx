import { MAX_MENU_IMAGE_BYTES, MENU_IMAGE_TYPES } from '@hospitality/constants';
import type { MenuItemDto } from '@hospitality/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/ApiContext';
import { AuthImage } from '../../components/AuthImage';
import { Button, Dialog, Field, TextField, errorText } from '../../components/ui';
import { useToast } from '../../components/Toast';
import {
  buildMenuPayload,
  emptyMenuForm,
  formFromItem,
  type MenuFormChoice,
  type MenuFormGroup,
  type MenuFormState,
} from './menu-form';

const PHOTO_ERROR = 'Choose a JPEG, PNG or WebP image under 2 MB.';

/** Add a new menu item, or change an existing one, including its options and photo. */
export function MenuItemDialog({
  item,
  categories,
  onClose,
}: {
  item?: MenuItemDto;
  categories: string[];
  onClose: () => void;
}) {
  const api = useApi();
  const queries = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<MenuFormState>(() =>
    item ? formFromItem(item) : emptyMenuForm(),
  );
  const [photo, setPhoto] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (patch: Partial<MenuFormState>): void =>
    setForm((current) => ({ ...current, ...patch }));
  const updateGroup = (index: number, patch: Partial<MenuFormGroup>): void =>
    change({ options: form.options.map((g, i) => (i === index ? { ...g, ...patch } : g)) });
  const updateChoice = (
    groupIndex: number,
    group: MenuFormGroup,
    choiceIndex: number,
    patch: Partial<MenuFormChoice>,
  ): void =>
    updateGroup(groupIndex, {
      choices: group.choices.map((c, i) => (i === choiceIndex ? { ...c, ...patch } : c)),
    });

  function pickPhoto(input: HTMLInputElement): void {
    const file = input.files?.[0];
    setPhotoError(null);
    if (!file) {
      setPhoto(null);
      return;
    }
    const allowed = (MENU_IMAGE_TYPES as readonly string[]).includes(file.type);
    if (!allowed || file.size > MAX_MENU_IMAGE_BYTES) {
      input.value = '';
      setPhoto(null);
      setPhotoError(PHOTO_ERROR);
      return;
    }
    setPhoto(file);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const built = buildMenuPayload(form);
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setBusy(true);
    let saved: MenuItemDto;
    try {
      saved = item
        ? (await api.patch<MenuItemDto>(`/menu/items/${item.id}`, built.value)).data
        : (await api.post<MenuItemDto>('/menu/items', built.value)).data;
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
      return;
    }

    // The item is saved from here on. A photo problem is reported, but the dialog still closes:
    // staying open would let a second "Save" create the same item twice.
    let photoProblem: string | null = null;
    try {
      if (photo) await api.upload(`/menu/items/${saved.id}/image`, photo);
      else if (item?.hasImage && removePhoto) await api.delete(`/menu/items/${saved.id}/image`);
    } catch (failure) {
      photoProblem = errorText(failure);
    }

    await queries.invalidateQueries({
      predicate: (query) => String(query.queryKey[0]).startsWith('/menu'),
    });
    if (photoProblem) {
      toast.error(`Saved ${built.value.name}, but the photo was not updated: ${photoProblem}`);
    } else {
      toast.success(item ? `Saved ${built.value.name}` : `Added ${built.value.name}`);
    }
    setBusy(false);
    onClose();
  }

  return (
    <Dialog title={item ? `Edit ${item.name}` : 'Add a menu item'} onClose={onClose}>
      <form onSubmit={(event) => void save(event)} className="space-y-3">
        <TextField
          label="Name"
          value={form.name}
          maxLength={80}
          onChange={(e) => change({ name: e.target.value })}
        />
        <TextField
          label="Category"
          list="menu-categories"
          value={form.category}
          maxLength={40}
          onChange={(e) => change({ category: e.target.value })}
        />
        <datalist id="menu-categories">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
        <TextField
          label="Price (₹)"
          inputMode="decimal"
          value={form.price}
          onChange={(e) => change({ price: e.target.value })}
          hint="Before tax, for one portion. Tax is added when the guest is billed."
        />
        <TextField
          label="Description (optional)"
          value={form.description}
          maxLength={300}
          onChange={(e) => change({ description: e.target.value })}
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.available}
            onChange={(e) => change({ available: e.target.checked })}
          />
          Available to order
        </label>

        <fieldset className="space-y-3 rounded-md p-3 ring-1 ring-stone-200">
          <legend className="px-1 text-sm font-medium text-slate-800">Options (optional)</legend>
          <p className="text-xs text-slate-500">
            For things like spice level or add-ons. Extra prices are added to the item price.
          </p>
          {form.options.map((group, groupIndex) => (
            <fieldset key={groupIndex} className="space-y-2 rounded-md bg-stone-50 p-3">
              <legend className="px-1 text-xs font-medium text-slate-600">
                Option group {groupIndex + 1}
              </legend>
              <TextField
                label="Option group name"
                value={group.name}
                maxLength={40}
                onChange={(e) => updateGroup(groupIndex, { name: e.target.value })}
              />
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={group.required}
                    onChange={(e) => updateGroup(groupIndex, { required: e.target.checked })}
                  />
                  Customer must choose one
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={group.multiple}
                    onChange={(e) => updateGroup(groupIndex, { multiple: e.target.checked })}
                  />
                  More than one choice allowed
                </label>
              </div>
              {group.choices.map((choice, choiceIndex) => (
                <div key={choiceIndex} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
                  <TextField
                    label={`Choice ${choiceIndex + 1} name`}
                    value={choice.label}
                    maxLength={40}
                    onChange={(e) =>
                      updateChoice(groupIndex, group, choiceIndex, { label: e.target.value })
                    }
                  />
                  <TextField
                    label={`Choice ${choiceIndex + 1} extra price (₹)`}
                    inputMode="decimal"
                    value={choice.extra}
                    onChange={(e) =>
                      updateChoice(groupIndex, group, choiceIndex, { extra: e.target.value })
                    }
                  />
                  <Button
                    variant="quiet"
                    small
                    aria-label={`Remove choice ${choiceIndex + 1}`}
                    onClick={() =>
                      updateGroup(groupIndex, {
                        choices: group.choices.filter((_, i) => i !== choiceIndex),
                      })
                    }
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  small
                  onClick={() =>
                    updateGroup(groupIndex, {
                      choices: [...group.choices, { label: '', extra: '' }],
                    })
                  }
                >
                  Add choice
                </Button>
                <Button
                  variant="quiet"
                  small
                  onClick={() =>
                    change({ options: form.options.filter((_, i) => i !== groupIndex) })
                  }
                >
                  Remove group
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            variant="secondary"
            small
            onClick={() =>
              change({
                options: [
                  ...form.options,
                  { name: '', required: false, multiple: false, choices: [] },
                ],
              })
            }
          >
            Add option group
          </Button>
        </fieldset>

        <div className="space-y-2">
          {item?.hasImage && (
            <div className="flex items-center gap-3">
              <AuthImage
                path={`/menu/items/${item.id}/image`}
                alt={item.name}
                version={item.updatedAt}
                className="h-16 w-16 rounded-md object-cover"
              />
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={removePhoto}
                  onChange={(e) => setRemovePhoto(e.target.checked)}
                />
                Remove the current photo
              </label>
            </div>
          )}
          <Field label="Photo (optional)" hint="JPEG, PNG or WebP, up to 2 MB">
            {(props) => (
              <input
                type="file"
                accept={MENU_IMAGE_TYPES.join(',')}
                className="block w-full text-sm text-slate-700"
                {...props}
                onChange={(e) => pickPhoto(e.target)}
              />
            )}
          </Field>
          {photoError && (
            <p role="alert" className="text-sm text-rose-700">
              {photoError}
            </p>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save item
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
