import { DEPARTMENTS, MAX_ROOM_RATE_PAISE } from '@hospitality/constants';
import { z } from 'zod';
import { shortText } from './common';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PINCODE = /^[1-9][0-9]{5}$/;

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN, 'must be a valid 15-character GSTIN');

export const timezoneSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid timezone such as Asia/Kolkata');

export const timeOfDaySchema = z.string().regex(TIME, 'must be a time like 14:00');

export const dateOnlySchema = z
  .string()
  .regex(DATE, 'must be a date like 2026-04-01')
  // Date.parse rolls 31 February over to March, so the date is checked by round-tripping it.
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'must be a real date');

export const addressSchema = z.object({
  line1: shortText(120),
  line2: z.string().trim().max(120).default(''),
  city: shortText(80),
  state: shortText(60),
  pincode: z.string().trim().regex(PINCODE, 'must be a 6-digit pincode'),
});

export const updatePropertySchema = z
  .object({
    name: shortText(120).optional(),
    legalName: shortText(160).optional(),
    address: addressSchema.optional(),
    stateName: shortText(60).optional(),
    gstin: gstinSchema.nullable().optional(),
    timezone: timezoneSchema.optional(),
    checkInTime: timeOfDaySchema.optional(),
    checkOutTime: timeOfDaySchema.optional(),
    departments: z
      .array(z.enum(DEPARTMENTS))
      .min(1)
      .transform((values) => [...new Set(values)])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

const percent = z.number().min(0).max(100);
const paise = z
  .number()
  .int()
  .min(0)
  .max(MAX_ROOM_RATE_PAISE * 100);

const slabSchema = z.object({
  upToPaise: paise.nullable(),
  ratePercent: percent,
});

/** A new set of tax rules, effective from a date. Added to the history, never replacing it. */
export const gstRuleSetSchema = z
  .object({
    effectiveFrom: dateOnlySchema,
    room: z.object({ slabs: z.array(slabSchema).min(1).max(10) }),
    food: z.object({
      ratePercent: percent,
      highTariffThresholdPaise: paise,
      highTariffRatePercent: percent,
    }),
    spaRecreation: z.object({ ratePercent: percent }),
    other: z.object({ ratePercent: percent }),
  })
  .superRefine((value, context) => {
    const slabs = value.room.slabs;
    slabs.forEach((slab, index) => {
      const isLast = index === slabs.length - 1;
      if (isLast && slab.upToPaise !== null) {
        context.addIssue({
          code: 'custom',
          path: ['room', 'slabs', index, 'upToPaise'],
          message: 'the last slab must have no upper limit',
        });
      }
      if (!isLast) {
        const next = slabs[index + 1];
        if (
          slab.upToPaise === null ||
          (next?.upToPaise !== null &&
            next?.upToPaise !== undefined &&
            next.upToPaise <= slab.upToPaise)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['room', 'slabs', index, 'upToPaise'],
            message: 'slab limits must be increasing and only the last may be unlimited',
          });
        }
      }
    });
  });
