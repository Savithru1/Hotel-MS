import type { OverviewEscalationDto, StaffDto } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import { Async, Button, Dialog, EmptyState, ErrorNotice, SelectField } from '../../components/ui';
import { useGet, useSend } from '../../hooks/queries';

const REFRESH = ['/manager', '/housekeeping', '/maintenance'];

/**
 * Picks who should take an escalated task. Only active staff of the matching role are offered,
 * and the server still decides whether the change is allowed (for example, housekeeping can be
 * reassigned while it is in progress, but not once it is finished).
 */
export function AssignDialog({
  escalation,
  onClose,
}: {
  escalation: OverviewEscalationDto;
  onClose: () => void;
}) {
  const role = escalation.kind;
  const people = useGet<StaffDto[]>('/staff', { role, active: true, limit: 100 });
  const [staffId, setStaffId] = useState('');
  const assign = useSend<unknown, { staffId: string }>(
    'post',
    `/${escalation.kind}/${escalation.id}/assign`,
    REFRESH,
  );
  const room = escalation.roomNumber ? `room ${escalation.roomNumber}` : 'this task';

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (staffId) assign.mutate({ staffId }, { onSuccess: onClose });
  }

  return (
    <Dialog title={`Assign or reassign ${role} task`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-600">Who should take {room}?</p>
        <Async query={people}>
          {(people.data?.data ?? []).length === 0 ? (
            <EmptyState>There is no active {role} staff to assign.</EmptyState>
          ) : (
            <SelectField
              label="Staff member"
              value={staffId}
              onChange={(event) => setStaffId(event.target.value)}
            >
              <option value="">Choose a person…</option>
              {(people.data?.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </SelectField>
          )}
        </Async>
        {assign.isError && <ErrorNotice error={assign.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={assign.isPending || !staffId}>
            Assign
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
