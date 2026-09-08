export const API_VERSION = "v0";
export const COLLECTION = "latest-continuous";
export const API_ROOT = `https://api.waterdata.usgs.gov/ogcapi/${API_VERSION}`;
export const ITEMS_ENDPOINT = `${API_ROOT}/collections/${COLLECTION}/items`;
export const SCHEMA_ENDPOINT = `${API_ROOT}/collections/${COLLECTION}/schema?f=json`;

export const REQUIRED_PROPERTIES = Object.freeze([
  "time_series_id",
  "monitoring_location_id",
  "parameter_code",
  "time",
  "last_modified",
  "value",
  "unit_of_measure",
  "approval_status",
  "qualifier"
]);

export const TARGETS = Object.freeze({
  "00010": { bucket: "temps", output: "medianTempC", units: ["degC"], digits: 1 },
  "00095": { bucket: "conds", output: "medianCond_uScm", units: ["uS/cm"], digits: 0 },
  "00400": { bucket: "phs", output: "medianPH", units: ["pH Units"], digits: 2 },
  "70300": { bucket: "tdses", output: "medianTDS_mgL", units: ["mg/L"], digits: 0 },
  "00300": { bucket: "dos", output: "medianDO_mgL", units: ["mg/l"], digits: 1 },
  "00076": { bucket: "turbsNTU", output: "medianTurb_NTU", units: ["NTU", "_NTU"], digits: 1 },
  "63680": { bucket: "turbsFNU", output: "medianTurb_FNU", units: ["FNU", "_FNU"], digits: 1 }
});

const DISQUALIFYING_QUALIFIERS = new Set(["DISCONTINUED", "EQUIP"]);
const ALLOWED_APPROVALS = new Set(["Approved", "Provisional"]);

export class SchemaDriftError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaDriftError";
  }
}

export function assertCollectionSchema(schema) {
  const keys = new Set(Object.keys(schema?.properties || {}));
  const missing = REQUIRED_PROPERTIES.filter((key) => !keys.has(key));
  if (missing.length) throw new SchemaDriftError(`USGS ${API_VERSION}/${COLLECTION} schema is missing: ${missing.join(", ")}`);
  return true;
}

export function assertFeatureShape(feature) {
  const properties = feature?.properties;
  if (!properties || typeof properties !== "object") throw new SchemaDriftError("USGS feature has no properties object.");
  const missing = REQUIRED_PROPERTIES.filter((key) => !Object.hasOwn(properties, key));
  if (missing.length) throw new SchemaDriftError(`USGS feature is missing: ${missing.join(", ")}`);
  return properties;
}

export function qualifierTokens(value) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

export function median(values, minimum = 3) {
  if (values.length < minimum) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const round = (value, digits) => value == null ? null : Number(value.toFixed(digits));

export function buildInitialUrl(fips) {
  if (!/^\d{2}$/.test(String(fips))) throw new Error(`Invalid state FIPS: ${fips}`);
  const codes = Object.keys(TARGETS).map((code) => `'${code}'`).join(",");
  const filter = `state_code='${fips}' AND site_type_code='ST' AND parameter_code IN (${codes})`;
  const params = new URLSearchParams({ f: "json", limit: "10000", "filter-lang": "cql2-text", filter });
  return `${ITEMS_ENDPOINT}?${params}`;
}

export function assertGovernedNextUrl(value) {
  const url = new URL(value);
  const expected = new URL(ITEMS_ENDPOINT);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new SchemaDriftError(`Ungoverned pagination target: ${url.origin}${url.pathname}`);
  }
  return url.href;
}

function classifyFeature(feature, { cutoff, now }) {
  const p = assertFeatureShape(feature);
  const target = TARGETS[p.parameter_code];
  if (!target) return { reason: "untargeted", properties: p };
  const value = Number(p.value);
  const time = Date.parse(p.time);
  const lastModified = Date.parse(p.last_modified);
  const qualifiers = qualifierTokens(p.qualifier);
  const base = { properties: p, target, value, time, lastModified, qualifiers };
  if (!p.time_series_id || !p.monitoring_location_id) return { ...base, reason: "missing-identity" };
  if (!Number.isFinite(value) || !Number.isFinite(time) || !Number.isFinite(lastModified) || time > now) return { ...base, reason: "invalid" };
  if (!ALLOWED_APPROVALS.has(p.approval_status)) return { ...base, reason: "invalid-approval" };
  if (!target.units.includes(p.unit_of_measure)) return { ...base, reason: "invalid-unit" };
  if (qualifiers.some((token) => DISQUALIFYING_QUALIFIERS.has(token.toUpperCase()))) return { ...base, reason: "disqualified" };
  if (time < cutoff) return { ...base, reason: "stale" };
  return { ...base, reason: "eligible" };
}

function metricStatus({ eligibleSites, staleReadings, rejectedReadings }) {
  if (eligibleSites >= 3) return "available";
  if (eligibleSites > 0) return "limited";
  if (staleReadings > 0) return "stale";
  if (rejectedReadings >= 0) return "unavailable";
  return "refresh-failed";
}

export function summarizeState(state, features, {
  now = Date.now(),
  windowDays = 30,
  windowHours = null,
  publicationMinimumSites = 3,
  includeMetricEvidence = false,
  includeOverallSites = true,
  includePolicyAudit = false
} = {}) {
  const effectiveWindowHours = windowHours == null ? windowDays * 24 : Number(windowHours);
  if (!Number.isFinite(effectiveWindowHours) || effectiveWindowHours <= 0) throw new Error("Observation window must be a positive number of hours.");
  if (!Number.isInteger(publicationMinimumSites) || publicationMinimumSites < 1) throw new Error("publicationMinimumSites must be a positive integer.");
  const cutoff = now - effectiveWindowHours * 36e5;
  const classified = features.map((feature) => classifyFeature(feature, { cutoff, now }));
  const latestBySiteParameter = new Map();

  for (const entry of classified.filter((item) => item.reason === "eligible")) {
    const p = entry.properties;
    const key = `${p.monitoring_location_id}|${p.parameter_code}`;
    const previous = latestBySiteParameter.get(key);
    if (!previous || entry.time > previous.time) latestBySiteParameter.set(key, entry);
  }

  const eligible = [...latestBySiteParameter.values()];
  const siteIds = new Set(eligible.map((entry) => entry.properties.monitoring_location_id));
  const summary = { state: state.state, metricStatus: {} };
  if (includeOverallSites) summary.sites = siteIds.size;
  if (includeMetricEvidence) summary.metricEvidence = {};
  const metrics = {};

  for (const [parameterCode, target] of Object.entries(TARGETS)) {
    const fetched = classified.filter((entry) => entry.properties?.parameter_code === parameterCode);
    const selected = eligible.filter((entry) => entry.properties.parameter_code === parameterCode);
    const selectedSites = new Set(selected.map((entry) => entry.properties.monitoring_location_id));
    const values = selected.map((entry) => entry.value);
    const staleReadings = fetched.filter((entry) => entry.reason === "stale").length;
    const rejectedReadings = fetched.filter((entry) => !["eligible", "stale"].includes(entry.reason)).length;
    const approvalCounts = Object.fromEntries(["Approved", "Provisional"].map((status) => [status.toLowerCase(), selected.filter((entry) => entry.properties.approval_status === status).length]));
    const status = metricStatus({ eligibleSites: selectedSites.size, staleReadings, rejectedReadings });
    summary[target.output] = round(median(values, publicationMinimumSites), target.digits);
    summary.metricStatus[target.output] = status;
    const observationTimes = selected.map((entry) => entry.time);
    if (includeMetricEvidence) {
      summary.metricEvidence[target.output] = {
        parameterCode,
        qualifyingSites: selectedSites.size,
        aggregation: selectedSites.size === 1 ? "latest" : selectedSites.size > 1 ? "median" : null,
        limitedCoverage: selectedSites.size > 0 && selectedSites.size < 3,
        sourceUnits: [...new Set(selected.map((entry) => entry.properties.unit_of_measure))].sort(),
        approvedReadings: approvalCounts.approved,
        provisionalReadings: approvalCounts.provisional,
        oldestObservation: observationTimes.length ? new Date(Math.min(...observationTimes)).toISOString() : null,
        newestObservation: observationTimes.length ? new Date(Math.max(...observationTimes)).toISOString() : null,
        status
      };
    }
    metrics[parameterCode] = {
      output: target.output,
      acceptedSourceUnits: target.units,
      fetchedReadings: fetched.length,
      eligibleReadings: selected.length,
      eligibleSites: selectedSites.size,
      approvedReadings: approvalCounts.approved,
      provisionalReadings: approvalCounts.provisional,
      staleReadings,
      rejectedReadings,
      rejectionReasons: Object.fromEntries([...new Set(fetched.map((entry) => entry.reason).filter((reason) => !["eligible", "stale"].includes(reason)))].sort().map((reason) => [reason, fetched.filter((entry) => entry.reason === reason).length])),
      newestObservation: selected.length ? new Date(Math.max(...selected.map((entry) => entry.time))).toISOString() : null,
      status
    };
  }

  const audit = {
    state: state.state,
    fips: state.fips,
    fetchedFeatures: features.length,
    eligibleSites: siteIds.size,
    metrics
  };
  if (includePolicyAudit) audit.policy = { observationWindowHours: effectiveWindowHours, publicationMinimumSites };
  return { summary, audit };
}

export function requestHeaders(apiKey) {
  if (!apiKey || !String(apiKey).trim()) throw new Error("USGS_API_KEY is required for a live refresh.");
  return { Accept: "application/geo+json, application/json", "X-Api-Key": String(apiKey).trim() };
}
