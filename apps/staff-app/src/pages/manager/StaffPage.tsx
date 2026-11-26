import { ASSIGNABLE_ROLES, outranks, type StaffRole } from '@hospitality/constants';
import type { StaffDto, StaffWithTemporaryPassword } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import { useStaff } from '../../auth/AuthContext';
import {
  Async,
  Badge,
  Button,
  Dialog,
  ErrorNotice,
  PageHeader,
  SelectField,
  TextField,
  errorText,
  words,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';

/** Shown once. The server never returns a temporary password again. */
function TemporaryPassword({
  result,
  onClose,
}: {
  result: StaffWithTemporaryPassword;
  onClose: () => void;
}) {
  return (
    <Dialog title="Temporary password" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Give this to <strong>{result.staff.name}</strong>. It is shown only now. They must change
          it the first time they sign in.
        </p>
        <p
          className="rounded-md bg-slate-900 px-3 py-2 text-center font-mono text-lg tracking-wider text-amber-200"
          data-testid="temporary-password"
        >
          {result.temporaryPassword}
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>I have noted it</Button>
        </div>
      </div>
    </Dialog>
  );
}

function CreateForm({
  actorRole,
  onCreated,
  onClose,
}: {
  actorRole: StaffRole;
  onCreated: (r: StaffWithTemporaryPassword) => void;
  onClose: () => void;
}) {
  const roles = ASSIGNABLE_ROLES.filter((role) => outranks(actorRole, role));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(roles[0] ?? 'front_desk');
  const create = useSend<StaffWithTemporaryPassword, object>('post', '/staff', ['/staff']);

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate({ name, email, role }, { onSuccess: onCreated });
  }

  return (
    <Dialog title="New staff member" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          hint="You can only give roles below your own."
        >
          {roles.map((value) => (
            <option key={value} value={value}>
              {words(value)}
            </option>
          ))}
        </SelectField>
        {create.isError && <ErrorNotice error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim() || !email.trim()}>
            Create account
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function StaffPage() {
  const { staff: me } = useStaff();
  const toast = useToast();
  const people = useList<StaffDto>('/staff', { limit: 100 });
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<StaffWithTemporaryPassword | null>(null);
  const update = useSend<StaffDto, { id: string } & Record<string, unknown>>(
    'patch',
    (body) => `/staff/${body.id}`,
    ['/staff'],
  );
  const reset = useSend<StaffWithTemporaryPassword, { id: string }>(
    'post',
    (body) => `/staff/${body.id}/reset-password`,
    ['/staff'],
  );
  const fail = (error: unknown): void => toast.error(errorText(error));

  return (
    <div>
      <PageHeader
        title="Staff"
        subtitle="Accounts for this property. Every change is recorded."
        actions={<Button onClick={() => setCreating(true)}>New staff member</Button>}
      />
      <Async query={people}>
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
          <table className="min-w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {people.items.map((person) => {
                const mayManage = person.id !== me.id && outranks(me.role, person.role);
                return (
                  <tr key={person.id}>
                    <td className="px-4 py-2">
                      <p className="font-medium">
                        {person.name}
                        {person.id === me.id && ' (you)'}
                      </p>
                      <p className="text-xs text-slate-500">{person.email}</p>
                    </td>
                    <td className="px-4 py-2 capitalize">{words(person.role)}</td>
                    <td className="px-4 py-2">
                      {person.active ? (
                        <Badge tone="good">Active</Badge>
                      ) : (
                        <Badge>Deactivated</Badge>
                      )}
                      {person.mustChangePassword && (
                        <span className="ml-1">
                          <Badge tone="warn">Temp password</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {mayManage && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="quiet"
                            small
                            onClick={() =>
                              update.mutate(
                                { id: person.id, active: !person.active },
                                { onError: fail },
                              )
                            }
                          >
                            {person.active ? 'Deactivate' : 'Reactivate'}
                          </Button>
                          <Button
                            variant="quiet"
                            small
                            onClick={() =>
                              reset.mutate(
                                { id: person.id },
                                { onSuccess: setShown, onError: fail },
                              )
                            }
                          >
                            Reset password
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Async>
      {creating && (
        <CreateForm
          actorRole={me.role}
          onClose={() => setCreating(false)}
          onCreated={(result) => {
            setCreating(false);
            setShown(result);
          }}
        />
      )}
      {shown && <TemporaryPassword result={shown} onClose={() => setShown(null)} />}
    </div>
  );
}
