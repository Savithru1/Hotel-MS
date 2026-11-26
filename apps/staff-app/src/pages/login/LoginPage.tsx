import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { Button, ErrorNotice, TextField } from '../../components/ui';

const SLUG_KEY = 'hotel.staff.propertySlug';

function rememberedSlug(): string {
  try {
    return window.localStorage.getItem(SLUG_KEY) ?? '';
  } catch {
    return '';
  }
}

export function LoginPage() {
  const { state, signIn } = useAuth();
  const navigate = useNavigate();
  const [propertySlug, setPropertySlug] = useState(rememberedSlug);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn({ propertySlug: propertySlug.trim(), email: email.trim(), password });
      try {
        window.localStorage.setItem(SLUG_KEY, propertySlug.trim());
      } catch {
        // Not remembering the property name is harmless.
      }
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const expired = state.status === 'signedOut' && state.expired;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-teal-900 p-4">
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8 shadow-2xl"
        aria-labelledby="login-title"
      >
        <div>
          <h1 id="login-title" className="font-serif text-2xl text-slate-900">
            Staff sign-in
          </h1>
          <p className="mt-1 text-sm text-slate-600">Use the details your manager gave you.</p>
        </div>

        {expired && (
          <p
            role="status"
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200"
          >
            Your session ended. Please sign in again.
          </p>
        )}

        <TextField
          label="Property"
          hint="The link name of your hotel, for example grand-plaza"
          value={propertySlug}
          onChange={(event) => setPropertySlug(event.target.value)}
          autoComplete="organization"
          autoCapitalize="none"
          required
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          required
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />

        {error !== null && <ErrorNotice error={error} />}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
