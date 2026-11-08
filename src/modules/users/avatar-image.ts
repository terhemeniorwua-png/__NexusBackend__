import sharp from 'sharp';
import { AppError } from '../../utils/errors';

/**
 * Magic-byte detection.
 *
 * We detect the format from the raw bytes, never from the filename or
 * Content-Type header, which are both trivially spoofable.
 */
function detectFormat(buffer: Buffer): 'jpeg' | 'png' | 'webp' | null {
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'png';
  }
  // WebP: RIFF????WEBP
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Normalises an uploaded avatar image.
 *
 * All accepted inputs (JPEG, PNG, WebP) are:
 *   - Detected by magic bytes, not filename or Content-Type.
 *   - Decoded by sharp to confirm the payload is a valid image.
 *   - Resized to at most 512 × 512 while preserving aspect ratio (fit: inside).
 *   - Re-encoded to WebP to strip all EXIF / GPS metadata and to produce a
 *     consistent output format with a deterministic .webp extension.
 *
 * Any file that fails to decode is rejected with AVATAR_IMAGE_INVALID.
 * Any file whose dimensions exceed the caller-supplied limits is rejected with
 * AVATAR_DIMENSIONS_TOO_LARGE.
 * Any file that is not a recognised image type is rejected with AVATAR_INVALID_TYPE.
 */
export async function normalizeAvatarImage(
  input: Buffer,
  limits: { maxDimension: number; maxPixels: number },
): Promise<{ body: Buffer; contentType: 'image/webp' }> {
  const format = detectFormat(input);
  if (!format) {
    throw new AppError(
      415,
      'AVATAR_INVALID_TYPE',
      'Upload a JPEG, PNG, or WebP image',
    );
  }

  try {
    // First pass: inspect metadata without decoding pixels.
    const header = sharp(input, { failOn: 'error' });
    const metadata = await header.metadata();

    if (
      !metadata.width ||
      !metadata.height ||
      !metadata.format ||
      metadata.format !== format
    ) {
      throw new AppError(415, 'AVATAR_IMAGE_INVALID', 'The uploaded image is invalid');
    }

    if (
      metadata.width > limits.maxDimension ||
      metadata.height > limits.maxDimension ||
      metadata.width * metadata.height > limits.maxPixels
    ) {
      throw new AppError(
        413,
        'AVATAR_DIMENSIONS_TOO_LARGE',
        'The image dimensions exceed the allowed limit',
      );
    }

    // Second pass: re-encode to WebP, resize to at most 512 × 512, and strip
    // all metadata (sharp strips EXIF by default; withMetadata is never called).
    const MAX_OUTPUT_DIMENSION = Math.min(512, limits.maxDimension);
    const body = await sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'error' })
      // Honour the EXIF orientation tag before stripping (rotate + strip).
      .rotate()
      .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();

    return { body, contentType: 'image/webp' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(415, 'AVATAR_IMAGE_INVALID', 'The uploaded image is invalid');
  }
}
