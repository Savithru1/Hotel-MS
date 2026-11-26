import { gstRuleSetSchema, updatePropertySchema } from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type { PropertyService, UpdatePropertyInput } from './property.service';
import type { GstRuleSet } from '@hospitality/shared-types';

export function propertyRouter(
  tokens: TokenService,
  auth: AuthService,
  properties: PropertyService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));

  // Any signed-in staff member can read the settings of their own property.
  router.get('/current', async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await properties.get(req.staff.propertyId) });
  });

  router.patch(
    '/current',
    requireRole('property_admin'),
    validate({ body: updatePropertySchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const updated = await properties.update(
        req.staff.propertyId,
        req.validated?.body as UpdatePropertyInput,
      );
      res.json({ success: true, data: updated });
    },
  );

  router.post(
    '/current/gst-rules',
    requireRole('property_admin'),
    validate({ body: gstRuleSetSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const updated = await properties.addGstRules(
        req.staff.propertyId,
        req.validated?.body as GstRuleSet,
      );
      res.status(201).json({ success: true, data: updated });
    },
  );

  documentRoute({
    method: 'get',
    path: '/properties/current',
    tag: 'Property',
    summary: 'Settings of your property',
    secured: true,
  });
  documentRoute({
    method: 'patch',
    path: '/properties/current',
    tag: 'Property',
    summary: 'Change property settings',
    secured: true,
    roles: ['property_admin'],
    body: updatePropertySchema,
  });
  documentRoute({
    method: 'post',
    path: '/properties/current/gst-rules',
    tag: 'Property',
    summary: 'Add an effective-dated set of GST rules',
    secured: true,
    roles: ['property_admin'],
    body: gstRuleSetSchema,
  });

  return router;
}
