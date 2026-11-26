import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/**
 * Every route registers itself here (next to its Zod schemas), and the OpenAPI document served
 * at `/openapi.json` and rendered at `/docs` is generated from this registry, so the docs cannot
 * drift away from the validation the API really performs.
 */
export const registry = new OpenAPIRegistry();

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Hospitality Platform API',
      version: '0.0.0',
      description:
        'Hotel management system API. Every response uses the envelope ' +
        '{ success, data | error, requestId }.',
    },
  });
}

/** Reusable envelope for error responses, for use in `registerPath` definitions. */
export const errorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string().openapi({ example: 'validation_error' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
    requestId: z.string().optional(),
  })
  .openapi('ErrorResponse');

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const successEnvelopeSchema = z
  .object({ success: z.literal(true), data: z.unknown() })
  .openapi('SuccessResponse');

export interface RouteDoc {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** Express-style path with `:id`; it is converted to the OpenAPI `{id}` form. */
  path: string;
  tag: string;
  summary: string;
  /** Needs a signed-in staff member. */
  secured?: boolean;
  body?: z.ZodObject;
  query?: z.ZodObject;
  params?: z.ZodObject;
  /** Roles allowed, shown in the description. Empty means any signed-in staff. */
  roles?: readonly string[];
}

/** Registers one route in the generated API docs, next to the route's own definition. */
export function documentRoute(route: RouteDoc): void {
  const rolesNote =
    route.roles && route.roles.length > 0 ? ` Allowed roles: ${route.roles.join(', ')}.` : '';
  registry.registerPath({
    method: route.method,
    path: `/api/v1${route.path.replace(/:(\w+)/g, '{$1}')}`,
    tags: [route.tag],
    summary: route.summary,
    description: `${route.summary}.${rolesNote}`,
    ...(route.secured ? { security: [{ bearerAuth: [] }] } : {}),
    request: {
      ...(route.params ? { params: route.params } : {}),
      ...(route.query ? { query: route.query } : {}),
      ...(route.body ? { body: { content: { 'application/json': { schema: route.body } } } } : {}),
    },
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': { schema: successEnvelopeSchema } },
      },
      default: {
        description: 'Error',
        content: { 'application/json': { schema: errorResponseSchema } },
      },
    },
  });
}
