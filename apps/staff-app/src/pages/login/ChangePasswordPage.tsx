import { PASSWORD_MIN_LENGTH, passwordSchema } from '@hospitality/validation';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth, useStaff } from '../../auth/AuthContext';
import { homePathFor } from '../../auth/permissions';
import { Button, Card, ErrorNotice, PageHeader, TextField } from '../../components/ui';
import { useToast } from '../../components/Toast';

export function ChangePasswordPage() {
  const { staff } = useStaff();
  const { changePassword } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const strength = passwordSchema.safeParse(next);
    if (!strength.success) {
      setProblem(strength.error.issues[0]?.message ?? 'is not strong enough');
      return;
    }
    if (next !== again) {
      setProblem('The two new passwords are not the same.');
      return;
    }
    setProblem(undefined);
    setBusy(true);
    try {
      await changePassword(current, next);
      toast.success('Password changed');
      navigate(homePathFor(staff.role), { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md">
      <PageHeader
        title="Change password"
        subtitle={
          staff.mustChangePassword
            ? 'You are using a temporary password. Choose your own to continue.'
            : 'Other devices will be signed out.'
        }
      />
      <Card>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <TextField
            label="Current password"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            required
          />
          <TextField
            label="New password"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number.`}
            error={problem?.startsWith('The two') ? undefined : problem && `Password ${problem}`}
            required
          />
          <TextField
            label="New password again"
            type="password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            autoComplete="new-password"
            error={problem?.startsWith('The two') ? problem : undefined}
            required
          />
          {error !== null && <ErrorNotice error={error} />}
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
