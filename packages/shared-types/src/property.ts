import type { Department, GuestIdType, RoomStatus } from '@hospitality/constants';

export interface GstSlab {
  /** The slab applies to nightly tariffs up to and including this many paise. `null` = no upper limit. */
  upToPaise: number | null;
  ratePercent: number;
}

/** One effective-dated set of tax rules. Rules are only ever added, never edited. */
export interface GstRuleSet {
  /** First day (YYYY-MM-DD, property time) the rules apply to new charges. */
  effectiveFrom: string;
  room: { slabs: GstSlab[] };
  food: {
    ratePercent: number;
    /** Above this room tariff, food is taxed at `highTariffRatePercent` instead. */
    highTariffThresholdPaise: number;
    highTariffRatePercent: number;
  };
  spaRecreation: { ratePercent: number };
  other: { ratePercent: number };
}

export interface PropertyAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}

export interface PropertyDto {
  id: string;
  name: string;
  slug: string;
  legalName: string;
  address: PropertyAddress;
  /** The state used to decide between CGST + SGST and IGST. */
  stateName: string;
  gstin: string | null;
  timezone: string;
  /** `HH:mm` in the property's timezone. */
  checkInTime: string;
  checkOutTime: string;
  currency: 'INR';
  departments: Department[];
  gstRules: GstRuleSet[];
}

export interface RoomTypeDto {
  id: string;
  name: string;
  capacity: number;
  /** Nightly tariff in paise. */
  ratePaise: number;
  amenities: string[];
  active: boolean;
}

export interface RoomDto {
  id: string;
  number: string;
  floor: number;
  roomTypeId: string;
  roomTypeName: string | null;
  status: RoomStatus;
  active: boolean;
}

export interface GuestDto {
  id: string;
  name: string;
  /** E.164, for example `+919876543210`. */
  phone: string;
  /** Empty until phone + OTP login exists. */
  phoneVerifiedAt: string | null;
  email: string | null;
  gstin: string | null;
  hasIdDetails: boolean;
  createdAt: string;
}

export interface GuestIdDetailsDto {
  idType: GuestIdType;
  idNumber: string;
}
