import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config, requireEnv } from "./config.js";

let client;

function getClient() {
  if (client) return client;

  client = new S3Client({
    endpoint: requireEnv("AWS_ENDPOINT_URL", config.s3.endpoint),
    region: requireEnv("AWS_DEFAULT_REGION", config.s3.region),
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID", config.s3.accessKeyId),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY", config.s3.secretAccessKey)
    }
  });

  return client;
}

export function assertStorageConfigured() {
  requireEnv("AWS_ENDPOINT_URL", config.s3.endpoint);
  requireEnv("AWS_ACCESS_KEY_ID", config.s3.accessKeyId);
  requireEnv("AWS_SECRET_ACCESS_KEY", config.s3.secretAccessKey);
  requireEnv("AWS_S3_BUCKET_NAME", config.s3.bucketName);
}

export async function putHtmlObject(key, html) {
  assertStorageConfigured();
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key,
      Body: html,
      ContentType: "text/html; charset=utf-8",
      CacheControl: "no-store"
    })
  );
}

export async function getHtmlObject(key) {
  assertStorageConfigured();
  const result = await getClient().send(
    new GetObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key
    })
  );
  return streamToString(result.Body);
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
