import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const REQUIRED_BUCKET = "admatera-maps-c7-private-preview-v1";
const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const runId = required("C7_RUN_ID");
const runDir = resolve(required("C7_RUN_DIR"));
const outcome = required("C7_REFRESH_OUTCOME");
const accountId = required("C7_R2_ACCOUNT_ID");
const bucket = required("C7_R2_BUCKET");
if (!/^MAP-DATA-012_\d{8}T\d{6}Z$/.test(runId)) throw new Error("C7_RUN_ID is not governed.");
if (bucket !== REQUIRED_BUCKET) throw new Error(`Refusing unapproved R2 bucket ${bucket}.`);
if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("C7_R2_ACCOUNT_ID is invalid.");

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("C7_R2_ACCESS_KEY_ID"),
    secretAccessKey: required("C7_R2_SECRET_ACCESS_KEY")
  }
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const put = (Key, Body, ContentType, immutable = false) => client.send(new PutObjectCommand({
  Bucket: bucket,
  Key,
  Body,
  ContentType,
  CacheControl: immutable ? "private, max-age=31536000, immutable" : "no-store",
  ...(immutable ? { IfNoneMatch: "*" } : {})
}));

const healthPath = resolve(runDir, "health.json");
const health = JSON.parse(await readFile(healthPath, "utf8"));
const healthKey = "health/current.json";

if (outcome !== "success" || health.status !== "available") {
  let lastValidRetained = false;
  try {
    await client.send(new GetObjectCommand({ Bucket: bucket, Key: "promoted/current.json" }));
    lastValidRetained = true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NoSuchKey") throw error;
  }
  const failedHealth = Buffer.from(JSON.stringify({ ...health, status: "refresh-failed", runId, lastValidRetained }, null, 2) + "\n");
  await put(healthKey, failedHealth, "application/json; charset=utf-8");
  console.log(`Recorded failed refresh ${runId}; promoted pointer unchanged.`);
  process.exit(0);
}

const files = [
  ["state-summary.json", "application/json; charset=utf-8"],
  ["health.json", "application/json; charset=utf-8"],
  ["audit.json", "application/json; charset=utf-8"],
  ["schema.json", "application/json; charset=utf-8"],
  ["usgs-raw-evidence.json.gz", "application/gzip"],
  ["SHA256SUMS.txt", "text/plain; charset=utf-8"]
];
const bodies = new Map();
for (const [name, contentType] of files) {
  const body = await readFile(resolve(runDir, name));
  bodies.set(name, body);
  await put(`snapshots/${runId}/${name}`, body, contentType, true);
}

const summary = bodies.get("state-summary.json");
if (health.candidateSha256 !== sha256(summary)) throw new Error("Health and state-summary hashes disagree.");
const promotedAt = new Date().toISOString();
const currentHealth = Buffer.from(JSON.stringify({ ...health, runId, promotedAt, lastValidRetained: false }, null, 2) + "\n");
await put(healthKey, currentHealth, "application/json; charset=utf-8");

const pointer = Buffer.from(JSON.stringify({
  schemaVersion: "admatera-c7-promoted-pointer-v2",
  runId,
  key: `snapshots/${runId}/state-summary.json`,
  sha256: sha256(summary),
  promotedAt,
  promotionMode: "automated-governed-refresh",
  policy: "rolling-24h-one-site-upward-v1"
}, null, 2) + "\n");
await put("promoted/current.json", pointer, "application/json; charset=utf-8");
console.log(`Promoted validated C7 refresh ${runId} after ${files.length} immutable uploads.`);
