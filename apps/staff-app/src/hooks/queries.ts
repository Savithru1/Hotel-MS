import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { PageMeta } from '@hospitality/shared-types';
import { useApi } from '../api/ApiContext';
import type { ApiError, ApiResult, Query } from '../api/client';

/** Reads a GET endpoint. The query key is the path plus the filters, so changing a filter refetches. */
export function useGet<T>(
  path: string,
  query?: Query,
  options: { enabled?: boolean } = {},
): UseQueryResult<ApiResult<T>, ApiError> {
  const api = useApi();
  return useQuery<ApiResult<T>, ApiError>({
    queryKey: [path, query ?? {}],
    queryFn: () => api.get<T>(path, query),
    enabled: options.enabled ?? true,
  });
}

/** A list endpoint: the items and the paging info. */
export function useList<T>(
  path: string,
  query?: Query,
): UseQueryResult<ApiResult<T[]>, ApiError> & { items: T[]; meta: PageMeta | undefined } {
  const result = useGet<T[]>(path, query);
  return Object.assign(result, { items: result.data?.data ?? [], meta: result.data?.meta });
}

type Method = 'post' | 'patch';

/**
 * A write: sends the body, then refetches every query whose path starts with one of
 * `invalidate` so lists on screen are never stale after a change.
 */
export function useSend<TResult, TBody = unknown>(
  method: Method,
  path: string | ((body: TBody) => string),
  invalidate: readonly string[] = [],
): UseMutationResult<TResult, ApiError, TBody> {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation<TResult, ApiError, TBody>({
    mutationFn: async (body) => {
      const target = typeof path === 'function' ? path(body) : path;
      return (await api[method]<TResult>(target, body)).data;
    },
    onSuccess: async () => {
      await Promise.all(
        invalidate.map((prefix) =>
          queries.invalidateQueries({
            predicate: (query) => String((query.queryKey as QueryKey)[0]).startsWith(prefix),
          }),
        ),
      );
    },
  });
}
