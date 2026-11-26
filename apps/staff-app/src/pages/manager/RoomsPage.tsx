import type { RoomDto, RoomTypeDto } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import { useStaff } from '../../auth/AuthContext';
import { isManager } from '../../auth/permissions';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';

function RoomForm({
  room,
  types,
  onClose,
}: {
  room?: RoomDto;
  types: RoomTypeDto[];
  onClose: () => void;
}) {
  const toast = useToast();
  const usable = types.filter((type) => type.active || type.id === room?.roomTypeId);
  const [number, setNumber] = useState(room?.number ?? '');
  const [floor, setFloor] = useState(String(room?.floor ?? 1));
  const [roomTypeId, setRoomTypeId] = useState(room?.roomTypeId ?? usable[0]?.id ?? '');
  const save = useSend<RoomDto, object>(
    room ? 'patch' : 'post',
    room ? `/rooms/${room.id}` : '/rooms',
    ['/rooms'],
  );

  function submit(event: FormEvent): void {
    event.preventDefault();
    save.mutate(
      { number, floor: Number(floor), roomTypeId },
      {
        onSuccess: () => {
          toast.success('Room saved');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title={room ? `Edit room ${room.number}` : 'New room'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Room number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            maxLength={10}
            required
          />
          <TextField
            label="Floor"
            type="number"
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            required
          />
        </div>
        <SelectField
          label="Room type"
          value={roomTypeId}
          onChange={(e) => setRoomTypeId(e.target.value)}
        >
          {usable.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </SelectField>
        {save.isError && <ErrorNotice error={save.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || !number.trim() || !roomTypeId}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RoomsPage() {
  const { staff } = useStaff();
  const toast = useToast();
  const canEdit = isManager(staff.role);
  const rooms = useList<RoomDto>('/rooms', { limit: 100 });
  const types = useList<RoomTypeDto>('/room-types');
  const [editing, setEditing] = useState<RoomDto | 'new' | null>(null);
  const toggle = useSend<RoomDto, { id: string; active: boolean }>(
    'patch',
    (body) => `/rooms/${body.id}`,
    ['/rooms'],
  );
  const status = useSend<RoomDto, { id: string; status: string }>(
    'post',
    (body) => `/rooms/${body.id}/status`,
    ['/rooms'],
  );
  useRefetchOnEvents(['room.status_changed'], [['/rooms']]);

  const change = (id: string, next: string): void =>
    status.mutate({ id, status: next }, { onError: (e) => toast.error(e.message) });

  return (
    <div>
      <PageHeader
        title="Rooms"
        actions={
          canEdit ? (
            <Button onClick={() => setEditing('new')} disabled={types.items.length === 0}>
              New room
            </Button>
          ) : undefined
        }
      />
      {canEdit && types.items.length === 0 && !types.isPending && (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          Add a room type first (Room types in the menu), then add rooms.
        </p>
      )}
      <Async query={rooms}>
        {rooms.items.length === 0 ? (
          <EmptyState>No rooms yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
            <table className="min-w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2">Room</th>
                  <th className="px-4 py-2">Floor</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rooms.items.map((room) => (
                  <tr key={room.id} className={room.active ? '' : 'opacity-60'}>
                    <td className="px-4 py-2 font-medium">
                      {room.number} {!room.active && <Badge>Retired</Badge>}
                    </td>
                    <td className="px-4 py-2">{room.floor}</td>
                    <td className="px-4 py-2">{room.roomTypeName}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={room.status} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {room.status !== 'out_of_service' && (
                          <Button
                            variant="quiet"
                            small
                            onClick={() => change(room.id, 'out_of_service')}
                          >
                            Out of service
                          </Button>
                        )}
                        {room.status === 'out_of_service' && (
                          <Button
                            variant="quiet"
                            small
                            onClick={() => change(room.id, 'available')}
                          >
                            Back in service
                          </Button>
                        )}
                        {canEdit && (
                          <Button variant="quiet" small onClick={() => setEditing(room)}>
                            Edit
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            variant="quiet"
                            small
                            onClick={() =>
                              toggle.mutate(
                                { id: room.id, active: !room.active },
                                { onError: (e) => toast.error(e.message) },
                              )
                            }
                          >
                            {room.active ? 'Retire' : 'Restore'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      {editing && (
        <RoomForm
          {...(editing === 'new' ? {} : { room: editing })}
          types={types.items}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
