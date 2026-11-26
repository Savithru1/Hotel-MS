import type { Department, StaffRole } from '@hospitality/constants';

/** A staff account as the API shows it. Never contains a password or its hash. */
export interface StaffDto {
  id: string;
  propertyId: string;
  name: string;
  email: string;
  role: StaffRole;
  departments: Department[];
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PropertySummaryDto {
  id: string;
  name: string;
  slug: string;
}

export interface AuthTokens {
  accessToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  refreshToken: string;
}

export interface Session {
  tokens: AuthTokens;
  staff: StaffDto;
  property: PropertySummaryDto;
}

/** Returned once when an account is created or its password is reset. */
export interface StaffWithTemporaryPassword {
  staff: StaffDto;
  temporaryPassword: string;
}
