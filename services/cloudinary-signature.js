// Legacy compatibility shim.
// Cloudinary media storage has been fully disabled. All media is Telegram-backed.

export function createCloudinarySignature() {
  throw new Error("Cloudinary storage is disabled. Use Telegram media storage.");
}

export function getCloudinaryConfig() {
  throw new Error("Cloudinary storage is disabled. Use Telegram media storage.");
}

export async function destroyCloudinaryVideo() {
  throw new Error("Cloudinary storage is disabled. Telegram is the media authority.");
}

export async function cloudinaryAssetExists() {
  return false;
}
