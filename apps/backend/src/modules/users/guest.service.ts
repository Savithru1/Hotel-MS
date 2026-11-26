import type { GuestIdType } from '@hospitality/constants';
import type { GuestDto, GuestIdDetailsDto } from '@hospitality/shared-types';
import { recordAudit } from '../../shared/audit/audit';
import { HttpError, conflict, notFound } from '../../shared/errors';
import { Guest, type GuestDocument } from './guest.model';

export interface IdDetailsInput {
  idType: GuestIdType;
  idNumber: string;
}

export interface CreateGuestInput {
  name: string;
  phone: string;
  email?: string | undefined;
  gstin?: string | undefined;
  idDetails?: IdDetailsInput | undefined;
}

export interface UpdateGuestInput {
  name?: string | undefined;
  phone?: string | undefined;
  email?: string | null | undefined;
  gstin?: string | null | undefined;
  idDetails?: IdDetailsInput | null | undefined;
}

export interface SearchGuestsInput {
  page: number;
  limit: number;
  q?: string | undefined;
}

export interface GuestService {
  search(input: SearchGuestsInput): Promise<{ items: GuestDto[]; total: number }>;
  get(id: string): Promise<GuestDto>;
  create(input: CreateGuestInput): Promise<GuestDto>;
  update(id: string, input: UpdateGuestInput): Promise<GuestDto>;
  /** Reads the ID document details. Every read is written to the audit log. */
  readIdDetails(id: string): Promise<GuestIdDetailsDto>;
}

type GuestRecord = Omit<GuestDocument, 'idDetails'> & { idDetails?: unknown };

export function toGuestDto(guest: GuestRecord): GuestDto {
  return {
    id: guest._id.toHexString(),
    name: guest.name,
    phone: guest.phone,
    phoneVerifiedAt: guest.phoneVerifiedAt ? guest.phoneVerifiedAt.toISOString() : null,
    email: guest.email,
    gstin: guest.gstin,
    hasIdDetails: Boolean(guest.idDetails),
    createdAt: guest.createdAt.toISOString(),
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function phoneTaken(existingId: string): HttpError {
  return new HttpError(409, 'phone_taken', 'A guest with that phone number already exists', {
    existingGuestId: existingId,
  });
}

const isDuplicate = (error: unknown): boolean => (error as { code?: unknown })?.code === 11000;

export function createGuestService(): GuestService {
  return {
    async search({ page, limit, q }) {
      let filter = {};
      if (q) {
        const text = new RegExp(escapeRegExp(q), 'i');
        // Phone numbers are stored as +91..., but people type them with spaces and dashes.
        const digits = q.replace(/[\s()-]/g, '');
        const phone = new RegExp(escapeRegExp(digits || q), 'i');
        filter = { $or: [{ name: text }, { email: text }, { phone }] };
      }
      const [items, total] = await Promise.all([
        Guest.find(filter)
          .sort({ name: 1, _id: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Guest.countDocuments(filter),
      ]);
      // `idDetails` is not selected by default, so existence is checked separately.
      const withId = new Set(
        (
          await Guest.find(
            { _id: { $in: items.map((g) => g._id) }, idDetails: { $exists: true } },
            { _id: 1 },
          ).lean()
        ).map((g) => g._id.toHexString()),
      );
      return {
        items: items.map((guest) =>
          toGuestDto({
            ...guest,
            idDetails: withId.has(guest._id.toHexString()) ? true : undefined,
          }),
        ),
        total,
      };
    },

    async get(id) {
      const guest = await Guest.findOne({ _id: id }).select('+idDetails').lean();
      if (!guest) throw notFound('Guest not found');
      return toGuestDto(guest);
    },

    async create(input) {
      const existing = await Guest.findOne({ phone: input.phone }, { _id: 1 }).lean();
      if (existing) throw phoneTaken(existing._id.toHexString());
      try {
        const created = await Guest.create({
          name: input.name,
          phone: input.phone,
          ...(input.email ? { email: input.email } : {}),
          ...(input.gstin ? { gstin: input.gstin } : {}),
          ...(input.idDetails ? { idDetails: input.idDetails } : {}),
        });
        await recordAudit({
          action: 'guest.created',
          target: { type: 'guest', id: created._id.toHexString() },
        });
        return toGuestDto({ ...created.toObject(), idDetails: input.idDetails });
      } catch (error) {
        // Two front-desk staff adding the same phone at once: the unique index decides.
        if (isDuplicate(error)) {
          const winner = await Guest.findOne({ phone: input.phone }, { _id: 1 }).lean();
          throw winner ? phoneTaken(winner._id.toHexString()) : conflict('Guest already exists');
        }
        throw error;
      }
    },

    async update(id, input) {
      const before = await Guest.findOne({ _id: id }, { _id: 1, phone: 1 }).lean();
      if (!before) throw notFound('Guest not found');

      if (input.phone && input.phone !== before.phone) {
        const clash = await Guest.findOne({ phone: input.phone }, { _id: 1 }).lean();
        if (clash) throw phoneTaken(clash._id.toHexString());
      }

      const set: Record<string, unknown> = {};
      const unset: Record<string, 1> = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        if (key === 'phone') {
          set.phone = value;
          // A changed number has not been verified, whatever it was before.
          set.phoneVerifiedAt = null;
        } else if (key === 'idDetails' && value === null) {
          unset.idDetails = 1;
        } else {
          set[key] = value;
        }
      }

      let updated;
      try {
        updated = await Guest.findOneAndUpdate(
          { _id: id },
          {
            ...(Object.keys(set).length ? { $set: set } : {}),
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
          { returnDocument: 'after', runValidators: true },
        )
          .select('+idDetails')
          .lean();
      } catch (error) {
        if (isDuplicate(error))
          throw conflict('A guest with that phone number already exists', 'phone_taken');
        throw error;
      }
      if (!updated) throw notFound('Guest not found');

      await recordAudit({
        action: 'guest.updated',
        target: { type: 'guest', id },
        summary: { fields: [...Object.keys(set), ...Object.keys(unset)] },
      });
      return toGuestDto(updated);
    },

    async readIdDetails(id) {
      const guest = await Guest.findOne({ _id: id }).select('+idDetails').lean();
      if (!guest) throw notFound('Guest not found');
      if (!guest.idDetails) throw notFound('This guest has no ID details on file', 'no_id_details');
      await recordAudit({
        action: 'guest.id_details_read',
        target: { type: 'guest', id },
      });
      return { idType: guest.idDetails.idType, idNumber: guest.idDetails.idNumber };
    },
  };
}
