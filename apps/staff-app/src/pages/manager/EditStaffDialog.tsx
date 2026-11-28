import {
  DEPARTMENTS,
  defaultDepartments,
  isManagementRole,
  type Department,
  type StaffRole,
} from '@hospitality/constants';
import type { StaffDto } from '@hospitality/shared-types';
import { updateStaffSchema } from '@hospitality/validation';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, ErrorNotice, SelectField, TextField, words } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useSend } from '../../hooks/queries';
import {
  assignableRoles,
  buildStaffUpdate,
  draftFrom,
  type StaffDraft,
  type StaffUpdate,
} from './staff-form';

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + words(value).slice(1);

function DepartmentBoxes({
  selected,
  onToggle,
  error,
}: {
  selected: readonly Department[];
  onToggle: (department: Department) => void;
  error: string | undefined;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-slate-700">Departments</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {DEPARTMENTS.map((department) => (
          <label key={department} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(department)}
              onChange={() => onToggle(department)}
            />
            {capitalise(department)}
          </label>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </fieldset>
  );
}

/** Why the draft cannot be sent yet, in words, or `undefined` when it can. */
function problemWith(update: StaffUpdate | null): string | undefined {
  if (!update) return undefined;
  const parsed = updateStaffSchema.safeParse(update);
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? 'Check the details');
}

/**
 * Edits a staff member's name, role and departments. Only the fields that changed are sent. The
 * role list only has roles below the actor's own; the server refuses anything else anyway.
 */
export function EditStaffDialog({
  person,
  actorRole,
  onClose,
}: {
  person: StaffDto;
  actorRole: StaffRole;
  onClose: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<StaffDraft>(() => draftFrom(person));
  const save = useSend<StaffDto, StaffUpdate>('patch', `/staff/${person.id}`, ['/staff']);
  const update = buildStaffUpdate(person, draft);
  const management = isManagementRole(draft.role);
  const noDepartments = !management && draft.departmentsEdited && draft.departments.length === 0;
  const problem = noDepartments ? undefined : problemWith(update);

  function changeRole(role: StaffRole): void {
    // Until the person picks departments themselves, show what the server will give this role.
    setDraft((now) => ({
      ...now,
      role,
      ...(now.departmentsEdited ? {} : { departments: defaultDepartments(role) }),
    }));
  }

  function toggle(department: Department): void {
    setDraft((now) => ({
      ...now,
      departmentsEdited: true,
      departments: now.departments.includes(department)
        ? now.departments.filter((value) => value !== department)
        : [...now.departments, department],
    }));
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!update || problem || noDepartments) return;
    save.mutate(update, {
      onSuccess: () => {
        toast.success(`Saved changes to ${person.name}`);
        onClose();
      },
    });
  }

  return (
    <Dialog title={`Edit ${person.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField
          label="Name"
          value={draft.name}
          maxLength={100}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          required
        />
        <SelectField
          label="Role"
          value={draft.role}
          onChange={(event) => changeRole(event.target.value as StaffRole)}
          hint="You can only give roles below your own."
        >
          {assignableRoles(actorRole).map((role) => (
            <option key={role} value={role}>
              {words(role)}
            </option>
          ))}
        </SelectField>
        {management ? (
          <p className="text-sm text-slate-600">Managers and owners cover every department.</p>
        ) : (
          <DepartmentBoxes
            selected={draft.departments}
            onToggle={toggle}
            error={noDepartments ? 'Pick at least one department.' : undefined}
          />
        )}
        {problem && <p className="text-xs text-rose-700">{problem}</p>}
        {save.isError && <ErrorNotice error={save.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={save.isPending || !update || Boolean(problem) || noDepartments}
          >
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
