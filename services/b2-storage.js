import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const BUCKET = String(process.env.B2_BUCKET_NAME || "").trim();
const ENDPOINT = String(process.env.B2_ENDPOINT || "").trim();
const KEY_ID = String(process.env.B2_KEY_ID || "").trim();
const APPLICATION_KEY = String(process.env.B2_APPLICATION_KEY || "").trim();

let client = null;

export function b2StorageConfigured() {
  return Boolean(BUCKET && ENDPOINT && KEY_ID && APPLICATION_KEY);
}

function getClient() {
  if (!b2StorageConfigured()) throw new Error("Backblaze B2 is not configured.");
  if (!client) {
    client = new S3Client({
      region: String(process.env.B2_REGION || "eu-central-003").trim(),
      endpoint: ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: KEY_ID,
        secretAccessKey: APPLICATION_KEY,
      },
    });
  }
  return client;
}

export async function uploadVideoBuffer({ buffer, key, contentType = "video/mp4", metadata = {} }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Video data is empty.");
  const objectKey = String(key || "").replace(/^\/+/, "");
  if (!objectKey || objectKey.includes("..")) throw new Error("Invalid B2 object key.");

  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: objectKey,
    Body: buffer,
    ContentType: contentType,
    Metadata: Object.fromEntries(
      Object.entries(metadata).map(([name, value]) => [String(name), String(value ?? "")]).filter(([, value]) => value),
    ),
  }));

  return { bucket: BUCKET, key: objectKey };
}

export async function getVideoObject({ key, range }) {
  const objectKey = String(key || "").replace(/^\/+/, "");
  if (!objectKey || objectKey.includes("..")) throw new Error("Invalid B2 object key.");
  const params = { Bucket: BUCKET, Key: objectKey };
  if (range) params.Range = range;
  return getClient().send(new GetObjectCommand(params));
}
