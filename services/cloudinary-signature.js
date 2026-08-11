import crypto from 'node:crypto';

export function createCloudinarySignature(timestamp) {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!apiSecret) {
    throw new Error('Cloudinary API secret is not configured.');
  }

  const payload = `timestamp=${timestamp}`;

  return crypto
    .createHash('sha1')
    .update(`${payload}${apiSecret}`)
    .digest('hex');
}

export function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;

  if (!cloudName || !apiKey) {
    throw new Error('Cloudinary cloud name or API key is not configured.');
  }

  return {
    cloudName,
    apiKey
  };
}
