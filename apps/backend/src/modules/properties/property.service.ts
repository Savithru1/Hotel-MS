import type { PropertyDto, GstRuleSet } from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { conflict, notFound } from '../../shared/errors';
import { runAsPlatform } from '../../shared/request-context';
import { Property, type PropertyDocument } from './property.model';

export interface UpdatePropertyInput {
  name?: string | undefined;
  legalName?: string | undefined;
  address?: PropertyDocument['address'] | undefined;
  stateName?: string | undefined;
  gstin?: string | null | undefined;
  timezone?: string | undefined;
  checkInTime?: string | undefined;
  checkOutTime?: string | undefined;
  departments?: PropertyDocument['departments'] | undefined;
}

export interface PropertyService {
  get(propertyId: Types.ObjectId): Promise<PropertyDto>;
  update(propertyId: Types.ObjectId, input: UpdatePropertyInput): Promise<PropertyDto>;
  /** Adds a new effective-dated rule set. Earlier sets are never changed. */
  addGstRules(propertyId: Types.ObjectId, rules: GstRuleSet): Promise<PropertyDto>;
}

export function toPropertyDto(property: PropertyDocument): PropertyDto {
  return {
    id: property._id.toHexString(),
    name: property.name,
    slug: property.slug,
    legalName: property.legalName,
    address: { ...property.address },
    stateName: property.stateName,
    gstin: property.gstin,
    timezone: property.timezone,
    checkInTime: property.checkInTime,
    checkOutTime: property.checkOutTime,
    currency: property.currency,
    departments: [...property.departments],
    gstRules: property.gstRules.map((set) => ({
      effectiveFrom: set.effectiveFrom,
      room: { slabs: set.room.slabs.map((slab) => ({ ...slab })) },
      food: { ...set.food },
      spaRecreation: { ...set.spaRecreation },
      other: { ...set.other },
    })),
  };
}

/**
 * The property is the tenant, so it has no tenant plugin. Every call here takes the property id
 * from the verified sign-in (never from the request) and touches only that one document.
 */
export function createPropertyService(): PropertyService {
  const load = async (propertyId: Types.ObjectId): Promise<PropertyDocument> => {
    const property = await runAsPlatform(() => Property.findById(propertyId).lean());
    if (!property) throw notFound('Property not found');
    return property;
  };

  return {
    async get(propertyId) {
      return toPropertyDto(await load(propertyId));
    },

    async update(propertyId, input) {
      const before = await load(propertyId);
      const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

      const updated = await runAsPlatform(() =>
        Property.findOneAndUpdate(
          { _id: propertyId },
          { $set: set },
          { returnDocument: 'after' },
        ).lean(),
      );
      if (!updated) throw notFound('Property not found');

      await recordAudit({
        action: 'property.updated',
        propertyId,
        target: { type: 'property', id: propertyId.toHexString() },
        summary: { fields: Object.keys(set), gstinChanged: before.gstin !== updated.gstin },
      });
      return toPropertyDto(updated);
    },

    async addGstRules(propertyId, rules) {
      const property = await load(propertyId);
      const latest = property.gstRules
        .map((set) => set.effectiveFrom)
        .sort()
        .at(-1);
      if (latest && rules.effectiveFrom <= latest) {
        throw conflict(
          `New tax rules must start after the latest existing set (${latest}). Earlier rules are never edited.`,
          'gst_rules_not_after_latest',
        );
      }

      const updated = await runAsPlatform(() =>
        Property.findOneAndUpdate(
          // The latest date is part of the filter so two admins adding at once cannot interleave.
          { _id: propertyId, 'gstRules.effectiveFrom': { $not: { $gte: rules.effectiveFrom } } },
          { $push: { gstRules: rules } },
          { returnDocument: 'after' },
        ).lean(),
      );
      if (!updated) {
        throw conflict('The tax rules changed while you were saving, please reload', 'conflict');
      }

      await recordAudit({
        action: 'property.gst_rules_added',
        propertyId,
        target: { type: 'property', id: propertyId.toHexString() },
        summary: { effectiveFrom: rules.effectiveFrom },
      });
      return toPropertyDto(updated);
    },
  };
}
