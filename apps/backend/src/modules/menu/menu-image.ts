import { MENU_IMAGE_TYPES, type MenuImageType } from '@hospitality/constants';

export function isMenuImageType(value: unknown): value is MenuImageType {
  return typeof value === 'string' && (MENU_IMAGE_TYPES as readonly string[]).includes(value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte)
  );
}

/**
 * Works out what kind of image some bytes really are, from their first bytes. The type the client
 * declares is never trusted: it is only accepted when the bytes agree with it. Returns null for
 * anything that is not a JPEG, PNG or WebP (SVG and HTML included).
 */
export function sniffImageType(bytes: Buffer): MenuImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  // WebP is a RIFF container: "RIFF", a 4-byte size, then "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return null;
}
