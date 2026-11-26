import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

interface ToastApi {
  success(text: string): void;
  error(text: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);
const SHOW_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const push = useCallback((text: string, tone: ToastItem['tone']) => {
    const id = nextId.current++;
    setItems((current) => [...current, { id, text, tone }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setItems((current) => current.filter((item) => item.id !== id));
    }, SHOW_MS);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active) clearTimeout(timer);
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ success: (text) => push(text, 'ok'), error: (text) => push(text, 'error') }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto max-w-sm rounded-md px-4 py-2 text-sm shadow-lg ${
              item.tone === 'error' ? 'bg-rose-700 text-white' : 'bg-slate-900 text-white'
            }`}
          >
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
