import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  API_VERSION,
  COLLECTION,
  SCHEMA_ENDPOINT,
  TARGETS,
  assertCollectionSchema,
  assertGovernedNextUrl,
  buildInitialUrl,
  requestHeaders,
  summarizeState
} from "./lib/usgs-ogc-v0.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : true];
}));
const root = resolve(import.meta.dirname, "..");
const fallback = resolve(args.fallback || resolve(root, "data/state-summary-last-validated.json"));
const output = resolve(args.output || resolve(root, "data/state-summary-candidate.json"));
const healthOutput = resolve(args.health || resolve(root, "data/usgs-refresh-health.json"));
const evidenceOutput = args.evidence ? resolve(args.evidence) : null;
const auditOutput = args.audit ? resolve(args.audit) : null;
const schemaOutput = args.schema ? resolve(args.schema) : null;
const windowDays = Number(args["window-days"] || 30);
const windowHours = args["window-hours"] == null ? null : Number(args["window-hours"]);
const publicationMinimumSites = Number(args["publication-minimum-sites"] || 3);
const includeMetricEvidence = Boolean(args["include-metric-evidence"]);
const includeOverallSites = !args["omit-overall-sites"];
const schemaVersion = String(args["schema-version"] || "admatera-water-summary-v1");
const maxPages = Number(args["max-pages"] || 20);
const statePaths = JSON.parse(await readFile(resolve(root, "data/state-paths.json"), "utf8"));
const requested = args.states ? new Set(String(args.states).toUpperCase().split(",")) : null;
const states = statePaths.states.filter((row) => (requested ? requested.has(row.state) : row.state !== "PR"));
const apiKey = process.env.USGS_API_KEY;
let headers;
const fetchedEvidence = [];

if (!args.live) throw new Error("Live network refresh requires --live. The packaged browser map never invokes this script.");
if (!Number.isFinite(windowDays) || windowDays < 1) throw new Error("window-days must be a positive number.");
if (windowHours != null && (!Number.isFinite(windowHours) || windowHours <= 0)) throw new Error("window-hours must be a positive number.");
if (!Number.isInteger(publicationMinimumSites) || publicationMinimumSites < 1) throw new Error("publication-minimum-sites must be a positive integer.");
if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("max-pages must be a positive integer.");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function fetchResponse(url, attempt = 1) {
  const response = await fetch(url, { headers });
  if (response.ok) return response;
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await delay(750 * 2 ** (attempt - 1));
    return fetchResponse(url, attempt + 1);
  }
  throw new Error(`USGS OGC request failed: HTTP ${response.status}`);
}

async function fetchJson(url) {
  const response = await fetchResponse(url);
  return { json: await response.json(), rateLimit: { limit: response.headers.get("x-ratelimit-limit"), remaining: response.headers.get("x-ratelimit-remaining") } };
}

async function fetchState(state, now) {
  const features = [];
  const pages = [];
  let url = buildInitialUrl(state.fips);
  while (url) {
    if (pages.length >= maxPages) throw new Error(`${state.state} exceeded ${maxPages} USGS pages.`);
    const { json, rateLimit } = await fetchJson(url);
    if (!Array.isArray(json.features) || !Array.isArray(json.links)) throw new Error(`${state.state} returned an invalid FeatureCollection.`);
    features.push(...json.features);
    pages.push({ url, numberReturned: json.numberReturned ?? json.features.length, rateLimit });
    const next = json.links.find((link) => link.rel === "next")?.href;
    url = next ? assertGovernedNextUrl(next) : null;
  }
  const result = summarizeState(state, features, {
    now,
    windowDays,
    windowHours,
    publicationMinimumSites,
    includeMetricEvidence,
    includeOverallSites,
    includePolicyAudit: schemaVersion === "admatera-water-summary-v2"
  });
  fetchedEvidence.push({ state: state.state, fips: state.fips, pages, features });
  return result;
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}

const checkedAt = new Date().toISOString();
try {
  headers = requestHeaders(apiKey);
  const { json: schema } = await fetchJson(SCHEMA_ENDPOINT);
  assertCollectionSchema(schema);
  const now = Date.now();
  const results = await pool(states, Number(args.concurrency || 3), (state) => fetchState(state, now));
  const summaries = results.map((result) => result.summary);
  const outputs = Object.values(TARGETS).map((target) => target.output);
  const populated = summaries.filter((row) => outputs.some((outputName) => row[outputName] != null)).length;
  const minimum = requested ? 1 : 45;
  if (populated < minimum) throw new Error(`Only ${populated}/${summaries.length} jurisdictions produced eligible readings; minimum is ${minimum}.`);
  const candidate = {
    schemaVersion,
    updatedAt: new Date().toISOString(),
    ...(windowHours == null ? { maxAgeDays: windowDays } : { observationWindowHours: windowHours }),
    publicationMinimumSites,
    source: { provider: "USGS", apiVersion: API_VERSION, collection: COLLECTION, siteTypeCode: "ST" },
    states: summaries
  };
  const candidateFileText = JSON.stringify(candidate, null, 2) + "\n";
  if (schemaOutput) await atomicWrite(schemaOutput, { retrievedAt: checkedAt, source: SCHEMA_ENDPOINT, sha256: sha256(JSON.stringify(schema)), schema });
  if (evidenceOutput) await atomicWrite(evidenceOutput, { source: { apiVersion: API_VERSION, collection: COLLECTION }, retrievedAt: checkedAt, queryRole: "server-side refresh evidence; never a browser runtime dependency", states: fetchedEvidence });
  if (auditOutput) await atomicWrite(auditOutput, {
    checkedAt,
    policy: {
      observationWindowHours: windowHours == null ? windowDays * 24 : windowHours,
    publicationMinimumSites,
    includeMetricEvidence,
    includeOverallSites,
    schemaVersion
    },
    states: results.map((result) => result.audit)
  });
  await atomicWrite(output, candidate);
  await atomicWrite(healthOutput, {
    schemaVersion: schemaVersion === "admatera-water-summary-v2" ? "admatera-water-refresh-health-v2" : undefined,
    status: "available",
    checkedAt,
    apiVersion: API_VERSION,
    collection: COLLECTION,
    statesRequested: states.length,
    statesPopulated: populated,
    candidateSha256: sha256(schemaVersion === "admatera-water-summary-v2" ? candidateFileText : JSON.stringify(candidate)),
    lastValidRetained: false
  });
  console.log(`Wrote ${states.length} jurisdiction summaries (${populated} populated) to ${output}`);
} catch (error) {
  let fallbackSha256 = null;
  try { fallbackSha256 = sha256(await readFile(fallback)); } catch {}
  await atomicWrite(healthOutput, { status: "refresh-failed", checkedAt, apiVersion: API_VERSION, collection: COLLECTION, error: error.message, lastValidRetained: Boolean(fallbackSha256), fallback, fallbackSha256 });
  console.error(`Refresh failed; last validated snapshot retained: ${error.message}`);
  process.exitCode = 1;
}
