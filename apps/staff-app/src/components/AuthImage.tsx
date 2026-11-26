import { useEffect, useState } from 'react';
import { useApi } from '../api/ApiContext';

type ImageState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed' };

/**
 * An image behind sign-in. An <img> tag cannot send the access token, so the file is fetched
 * through the API client (which also renews an expired token) and shown from a temporary URL
 * that is released again when the image goes away. `version` makes it load again after a change.
 */
export function AuthImage({
  path,
  alt,
  version = '',
  className = '',
}: {
  path: string;
  alt: string;
  version?: string;
  className?: string;
}) {
  const api = useApi();
  const [state, setState] = useState<ImageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    api.getBlob(path).then(
      (blob) => {
        if (cancelled) return;
        // Only ever show something that really is an image.
        if (!blob.type.startsWith('image/')) {
          setState({ status: 'failed' });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      },
      () => {
        if (!cancelled) setState({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path, version]);

  if (state.status === 'ready') return <img src={state.url} alt={alt} className={className} />;
  return (
    <div
      role={state.status === 'failed' ? 'img' : undefined}
      aria-label={state.status === 'failed' ? `Photo of ${alt} could not be loaded` : undefined}
      aria-hidden={state.status === 'loading' ? true : undefined}
      className={`bg-stone-100 ${className}`}
    />
  );
}
