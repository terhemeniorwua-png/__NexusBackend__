import sharp from 'sharp';
import { AppError } from '../../utils/errors';

export type AvatarFormat = 'jpeg' | 'png' | 'webp';

function detectFormat(buffer: Buffer): AvatarFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

export async function normalizeAvatarImage(
  input: Buffer,
  limits: { maxDimension: number; maxPixels: number },
): Promise<{ body: Buffer; contentType: string; format: AvatarFormat }> {
  const format = detectFormat(input);
  if (!format)
    throw new AppError(415, 'AVATAR_TYPE_UNSUPPORTED', 'Upload a JPEG, PNG, or WebP image');
  try {
    const header = sharp(input, { failOn: 'error' });
    const metadata = await header.metadata();
    if (!metadata.width || !metadata.height || !metadata.format || metadata.format !== format) {
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
    const image = sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'error' });
    const body = await image.rotate().toFormat(format, { quality: 85, effort: 4 }).toBuffer();
    return { body, contentType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`, format };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(415, 'AVATAR_IMAGE_INVALID', 'The uploaded image is invalid');
  }
}
