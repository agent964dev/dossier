export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  bootstrapApiKey: process.env.POSTPLAN_BOOTSTRAP_API_KEY,
  publicBaseUrl: process.env.POSTPLAN_PUBLIC_BASE_URL,
  maxHtmlBytes: Number(process.env.MAX_HTML_BYTES || 512 * 1024),
  // Web sign-in (dashboard). Absent POSTPLAN_SESSION_SECRET, all web-auth
  // routes respond 503 and the API/serving paths are unaffected.
  sessionSecret: process.env.POSTPLAN_SESSION_SECRET,
  shooBaseUrl: (process.env.SHOO_BASE_URL || "https://shoo.dev").replace(/\/+$/, ""),
  s3: {
    endpoint: process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME,
    region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "auto",
    forcePathStyle: (process.env.AWS_S3_FORCE_PATH_STYLE || "true") !== "false"
  }
};

export function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
