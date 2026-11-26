import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../api/client';

/** Turns any thrown value into a sentence a person can act on. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = (error.details as { issues?: { path: string; message: string }[] } | undefined)
      ?.issues;
    if (error.code === 'validation_error' && issues?.length) {
      return issues
        .map(
          (issue) => `${issue.path.split('.').slice(1).join('.') || issue.path} ${issue.message}`,
        )
        .join('; ');
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-teal-800 text-white hover:bg-teal-900 focus-visible:outline-teal-800',
  secondary:
    'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-slate-500',
  danger: 'bg-rose-700 text-white hover:bg-rose-800 focus-visible:outline-rose-700',
  quiet: 'text-teal-900 hover:bg-teal-50 focus-visible:outline-teal-800',
};

export function Button({
  variant = 'primary',
  small = false,
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        small ? 'px-2.5 py-1 text-sm' : 'px-4 py-2 text-sm'
      } ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

const FIELD =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-teal-700 disabled:bg-slate-100';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error || hint ? `${id}-note` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children({ id, ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
      {(error || hint) && (
        <p
          id={describedBy}
          className={`mt-1 text-xs ${error ? 'text-rose-700' : 'text-slate-500'}`}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <Field label={label} {...(hint ? { hint } : {})} error={error}>
      {(props) => <input className={FIELD} {...props} {...input} />}
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})} error={error}>
      {(props) => (
        <select className={FIELD} {...props} {...select}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function TextAreaField({
  label,
  ...area
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <Field label={label}>
      {(props) => <textarea rows={3} className={FIELD} {...props} {...area} />}
    </Field>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg bg-white shadow-sm ring-1 ring-stone-200 ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold tracking-wide text-slate-700">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-serif text-2xl text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  neutral: 'bg-slate-100 text-slate-700',
  good: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-rose-100 text-rose-800',
  info: 'bg-sky-100 text-sky-800',
  busy: 'bg-violet-100 text-violet-800',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export const words = (value: string): string => value.replaceAll('_', ' ');
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const STATUS_TONES: Record<string, Tone> = {
  available: 'good',
  occupied: 'busy',
  reserved: 'info',
  cleaning: 'warn',
  maintenance: 'bad',
  out_of_service: 'bad',
  pending: 'warn',
  confirmed: 'info',
  checked_in: 'busy',
  checked_out: 'neutral',
  cancelled: 'neutral',
  no_show: 'bad',
  new: 'info',
  assigned: 'warn',
  in_progress: 'busy',
  completed: 'good',
  resolved: 'good',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{capitalise(words(status))}</Badge>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" />
      {label}…
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-md bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200"
    >
      <p>{errorText(error)}</p>
      {onRetry && (
        <Button variant="secondary" small className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

/** Shows a loading spinner, an error with retry, or the content. */
export function Async({
  query,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: ReactNode;
}) {
  if (query.isPending) return <Spinner />;
  if (query.isError)
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children}</>;
}

/** A modal dialog. Closes on Escape, returns focus, and traps nothing outside the browser's own handling. */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      // jsdom has no showModal; the open attribute is enough there.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-full max-w-lg rounded-xl p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="font-serif text-xl text-slate-900">
            {title}
          </h2>
          <Button variant="quiet" small onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function money(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

export function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
