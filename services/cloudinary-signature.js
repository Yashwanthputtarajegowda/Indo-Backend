import crypto from 'node:crypto';

export function createCloudinarySignature(timestamp, params = {}) {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret) throw new Error('Cloudinary API secret is not configured.');

  const payload = Object.entries({ ...params, timestamp })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto.createHash('sha1').update(`${payload}${apiSecret}`).digest('hex');
}

export function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  if (!cloudName || !apiKey) throw new Error('Cloudinary cloud name or API key is not configured.');
  return { cloudName, apiKey };
}
