import type { StaffRole } from '@hospitality/constants';
import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../shared/errors';

/**
 * Allows only the listed roles. `platform_admin` is always allowed. Must come after
 * `authenticate`. The role is the one stored in the database, never anything the client sent.
 */
export function requireRole(...allowed: StaffRole[]): RequestHandler {
  const roles = new Set<StaffRole>([...allowed, 'platform_admin']);
  return (req, _res, next) => {
    if (!req.staff) throw unauthorized();
    if (!roles.has(req.staff.role)) throw forbidden();
    next();
  };
}

/** Roles that run a whole property. */
export const MANAGEMENT: readonly StaffRole[] = ['property_admin', 'manager'];
