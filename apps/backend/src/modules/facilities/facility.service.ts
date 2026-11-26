import { FACILITY_HOLDING_STATUSES, type FacilityType } from '@hospitality/constants';
import type { FacilityDto, FacilitySlotDto } from '@hospitality/shared-types';
import { toMinutes } from '@hospitality/validation';
import type { Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { localDateTimeToUtc } from '../../shared/dates';
import { HttpError, conflict, notFound } from '../../shared/errors';
import { getTenantId } from '../../shared/request-context';
import type { PropertyService } from '../properties/property.service';
import { FacilityBooking } from './facility-booking.model';
import { FacilitySlot } from './facility-slot.model';
import { buildSlots } from './facility-slots';
import { Facility, type FacilityDocument } from './facility.model';
import { toFacilityDto } from './facility.mapper';

export interface CreateFacilityInput {
  name: string;
  type: FacilityType;
  description: string;
  capacity: number;
  slotMinutes: number;
  opensAt: string;
  closesAt: string;
  pricePaise: number;
  active: boolean;
}

export type UpdateFacilityInput = Partial<CreateFacilityInput>;

export interface ListFacilitiesInput {
  page: number;
  limit: number;
  type?: FacilityType | undefined;
  active?: boolean | undefined;
}

export interface FacilityService {
  list(input: ListFacilitiesInput): Promise<{ items: FacilityDto[]; total: number }>;
  get(id: string): Promise<FacilityDto>;
  create(input: CreateFacilityInput): Promise<FacilityDto>;
  update(id: string, input: UpdateFacilityInput): Promise<FacilityDto>;
  /** Every slot of one day with how full it is. `date` is `YYYY-MM-DD` in the property's timezone. */
  slots(id: string, date: string): Promise<FacilitySlotDto[]>;
}

/** Changes that would move or shrink slots people may already have booked. */
const SCHEDULE_FIELDS = ['slotMinutes', 'opensAt', 'closesAt', 'capacity'] as const;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

const duplicateName = (): HttpError =>
  conflict('A facility with that name already exists', 'duplicate_facility');

function invalidHours(message: string): HttpError {
  return new HttpError(400, 'validation_error', 'Request validation failed', {
    issues: [{ path: 'closesAt', message }],
  });
}

/** The opening hours must be a real range that holds at least one slot. */
function assertHours(opensAt: string, closesAt: string, slotMinutes: number): void {
  const span = toMinutes(closesAt) - toMinutes(opensAt);
  if (span <= 0) throw invalidHours('must be after the opening time');
  if (span < slotMinutes) throw invalidHours('is too short for even one slot');
}

export function createFacilityService(properties: PropertyService): FacilityService {
  const tenant = (): Types.ObjectId => {
    const id = getTenantId();
    if (!id) throw new Error('No tenant context');
    return id;
  };
  const timezone = async (): Promise<string> => (await properties.get(tenant())).timezone;

  async function load(id: string): Promise<FacilityDocument> {
    const facility = await Facility.findOne({ _id: id }).lean();
    if (!facility) throw notFound('Facility not found');
    return facility;
  }

  async function audit(
    action: string,
    facility: FacilityDocument,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await recordAudit({
      action: `facility.${action}`,
      target: { type: 'facility', id: facility._id.toHexString() },
      summary: { name: facility.name, ...extra },
    });
  }

  return {
    async list(input) {
      const filter: Record<string, unknown> = {};
      if (input.type) filter.type = input.type;
      if (input.active !== undefined) filter.active = input.active;
      const [items, total] = await Promise.all([
        Facility.find(filter)
          .sort({ type: 1, nameKey: 1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        Facility.countDocuments(filter),
      ]);
      return { items: items.map(toFacilityDto), total };
    },

    async get(id) {
      return toFacilityDto(await load(id));
    },

    async create(input) {
      assertHours(input.opensAt, input.closesAt, input.slotMinutes);
      let facility: FacilityDocument;
      try {
        const created = await Facility.create({ ...input, nameKey: input.name.toLowerCase() });
        facility = created.toObject();
      } catch (error) {
        if (isDuplicateKey(error)) throw duplicateName();
        throw error;
      }
      await audit('created', facility, { type: facility.type, capacity: facility.capacity });
      return toFacilityDto(facility);
    },

    async update(id, input) {
      const before = await load(id);
      const changes: Record<string, unknown> = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      assertHours(
        input.opensAt ?? before.opensAt,
        input.closesAt ?? before.closesAt,
        input.slotMinutes ?? before.slotMinutes,
      );

      const scheduleChanged = SCHEDULE_FIELDS.some(
        (field) => input[field] !== undefined && input[field] !== before[field],
      );
      if (scheduleChanged) {
        // People may have booked slots as they are now. Moving or shrinking them would break
        // those bookings, so it has to wait until they are done or cancelled.
        const holding = await FacilityBooking.exists({
          facilityId: before._id,
          status: { $in: [...FACILITY_HOLDING_STATUSES] },
          slotStart: { $gte: new Date() },
        });
        if (holding) {
          throw conflict(
            'Open bookings hold slots of this facility. Finish or cancel them before changing the hours, slot length or capacity.',
            'facility_in_use',
          );
        }
      }
      if (input.name !== undefined) changes.nameKey = input.name.toLowerCase();

      let updated: FacilityDocument | null;
      try {
        updated = await Facility.findOneAndUpdate(
          { _id: id },
          { $set: changes },
          { returnDocument: 'after', runValidators: true },
        ).lean();
      } catch (error) {
        if (isDuplicateKey(error)) throw duplicateName();
        throw error;
      }
      if (!updated) throw notFound('Facility not found');

      await audit('updated', updated, {
        fields: Object.keys(input).filter(
          (key) => input[key as keyof UpdateFacilityInput] !== undefined,
        ),
        ...(updated.pricePaise !== before.pricePaise
          ? { previousPricePaise: before.pricePaise, pricePaise: updated.pricePaise }
          : {}),
      });
      return toFacilityDto(updated);
    },

    async slots(id, date) {
      const facility = await load(id);
      const tz = await timezone();
      const grid = buildSlots(facility.opensAt, facility.closesAt, facility.slotMinutes).map(
        (slot) => ({ ...slot, start: localDateTimeToUtc(date, slot.startTime, tz) }),
      );
      const counters = await FacilitySlot.find({
        facilityId: facility._id,
        slotStart: { $in: grid.map((slot) => slot.start) },
      }).lean();
      const booked = new Map(counters.map((row) => [row.slotStart.getTime(), row.booked]));

      const now = Date.now();
      return grid.map((slot): FacilitySlotDto => {
        const taken = booked.get(slot.start.getTime()) ?? 0;
        const remaining = Math.max(0, facility.capacity - taken);
        const past = slot.start.getTime() <= now;
        return {
          startTime: slot.startTime,
          endTime: slot.endTime,
          capacity: facility.capacity,
          booked: taken,
          remaining,
          past,
          bookable: facility.active && !past && remaining > 0,
        };
      });
    },
  };
}
