import mongoose, { Schema, type Types } from 'mongoose';

export interface RefreshTokenDocument {
  _id: Types.ObjectId;
  /** Keyed hash of the token. The token itself is never stored. */
  tokenHash: string;
  /** All tokens that descend from one sign-in share a family, so they can be revoked together. */
  family: string;
  /** When the original sign-in happened. Rotation never moves it, so a session cannot slide forever. */
  familyCreatedAt: Date;
  principal: { kind: 'staff'; id: Types.ObjectId };
  propertyId: Types.ObjectId;
  usedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Not tenant-scoped on purpose: the refresh endpoint receives only the token, and the property
 * is read from the stored record. The token is a 256-bit random value, so it cannot be guessed.
 * It is on the allow-list in `tenant-models.test.ts`.
 */
const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    familyCreatedAt: { type: Date, required: true },
    principal: {
      kind: { type: String, enum: ['staff'], required: true },
      id: { type: Schema.Types.ObjectId, required: true },
    },
    propertyId: { type: Schema.Types.ObjectId, required: true },
    usedAt: { type: Date, default: null },
    // The database deletes the document itself once this moment has passed.
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

refreshTokenSchema.index({ 'principal.id': 1 });

export const RefreshToken =
  (mongoose.models.RefreshToken as mongoose.Model<RefreshTokenDocument> | undefined) ??
  mongoose.model<RefreshTokenDocument>('RefreshToken', refreshTokenSchema, 'refresh_tokens');
