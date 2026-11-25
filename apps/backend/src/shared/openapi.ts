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
