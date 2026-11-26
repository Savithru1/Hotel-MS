import type { FacilityBookingDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Button, Dialog, ErrorNotice, TextField } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useSend } from '../../hooks/queries';

/** Cancelling needs a reason, so the history says why a guest's session did not happen. */
export function CancelFacilityBookingDialog({
  booking,
  onClose,
}: {
  booking: FacilityBookingDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const cancel = useSend<FacilityBookingDto, { reason: string }>(
    'post',
    `/facility-bookings/${booking.id}/cancel`,
    ['/facility-bookings'],
  );

  return (
    <Dialog title={`Cancel booking ${booking.code}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {booking.facilityName} at {booking.startTime} for room {booking.roomNumber}. The places go
          back to the slot. This cannot be undone.
        </p>
        <TextField
          label="Why is it being cancelled?"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={200}
        />
        {cancel.isError && <ErrorNotice error={cancel.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="danger"
            disabled={cancel.isPending || reason.trim().length < 3}
            onClick={() =>
              cancel.mutate(
                { reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast.success(`Booking ${booking.code} cancelled`);
                    onClose();
                  },
                },
              )
            }
          >
            Cancel this booking
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
