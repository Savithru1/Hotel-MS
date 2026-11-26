import type { FoodOrderDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Button, Dialog, ErrorNotice, TextField } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useSend } from '../../hooks/queries';

/** Cancelling needs a reason, so the history says why an order never reached the guest. */
export function CancelOrderDialog({
  order,
  onClose,
}: {
  order: FoodOrderDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const cancel = useSend<FoodOrderDto, { reason: string }>(
    'post',
    `/food-orders/${order.id}/cancel`,
    ['/food-orders'],
  );

  return (
    <Dialog title={`Cancel order ${order.code}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Room {order.roomNumber} for {order.guestName}. This cannot be undone.
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
                    toast.success(`Order ${order.code} cancelled`);
                    onClose();
                  },
                },
              )
            }
          >
            Cancel this order
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
