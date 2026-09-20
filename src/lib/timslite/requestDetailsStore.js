import { createHash } from "node:crypto";

import { TIMSLITE_REQUEST_DETAILS_PATH } from "@/lib/db/paths.js";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_FLUSH_INTERVAL_SECONDS = 15;
export const TIMSLITE_RECORD_MAX_BYTES = 4 * 1024 * 1024;
export const TIMSLITE_RECORD_SAFE_BYTES = TIMSLITE_RECORD_MAX_BYTES - 64 * 1024;
const DATASET_NAME = "requestDetails";
const DATASET_TYPE = "raw";
const MIN_TRUNCATION_MARKER_BYTES = Buffer.byteLength(JSON.stringify({ __truncated: true }), "utf8");

const TRUNCATABLE_FIELDS = ["request", "providerRequest", "providerResponse", "response"];

const DEDUP_FIELDS = ["request", "providerRequest"];

const VALUES_KEY = "__values__";

// Ref wire format "#/<id>/<sha256-hex>" where id=0 means local __values__,
// nonzero means the timslite_id of the record that owns the value.
export const TIMSLITE_VALUE_REF_PATTERN = /^#\/(0|[1-9]\d{0,19})\/([a-f0-9]{64})$/;

export const TIMSLITE_VALUE_CACHE_MAX_ENTRIES = 2048;


const MICROSECONDS_PER_HOUR = 60n * 60n * 1_000_000n;
const FORTY_EIGHT_HOURS_MICROSECONDS = 48n * MICROSECONDS_PER_HOUR;

// Cross-record reuse stays within the retention window minus one hour of
// safety margin, capped at 48h; a non-positive budget disables it.
export function computeCrossRecordTtlMicroseconds(retentionWindow) {
  const budget = retentionWindow - MICROSECONDS_PER_HOUR;
  const ttl = budget < FORTY_EIGHT_HOURS_MICROSECONDS ? budget : FORTY_EIGHT_HOURS_MICROSECONDS;
  return ttl > 0n ? ttl : 0n;
}

function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

// Module-global LRU state shared across all createValueCache instances.
// Each store instance applies its own effective TTL when reading entries.
const globalEntries = new Map();

// Reset global cache state. Exported for test isolation.
export function _resetGlobalValueCache() {
  globalEntries.clear();
}

// Cache stores { timsliteId, writtenAt } per SHA — never the value itself.
// Backing map is module-global so values survive across store instances.
export function createValueCache({ maxEntries = TIMSLITE_VALUE_CACHE_MAX_ENTRIES, ttlMicroseconds = 0n, clock = Date.now } = {}) {
  function nowMicros() {
    return BigInt(clock()) * 1000n;
  }

  function isExpired(entry, now) {
    return ttlMicroseconds <= 0n || now - entry.writtenAt >= ttlMicroseconds;
  }

  return {
    get enabled() {
      return ttlMicroseconds > 0n;
    },
    ttlMicroseconds,
    // Returns the timslite_id string for the cached SHA, or undefined.
    getTimsliteId(sha) {
      if (ttlMicroseconds <= 0n) return undefined;
      const entry = globalEntries.get(sha);
      if (entry === undefined) return undefined;
      if (isExpired(entry, nowMicros())) {
        globalEntries.delete(sha);
        return undefined;
      }
      // Move to end (most recently used)
      globalEntries.delete(sha);
      globalEntries.set(sha, entry);
      return entry.timsliteId;
    },
    // Store the timslite_id for a SHA after a successful write.
    setTimsliteId(sha, timsliteId, writtenAtMicros = nowMicros()) {
      if (ttlMicroseconds <= 0n) return;
      globalEntries.delete(sha);
      globalEntries.set(sha, { timsliteId, writtenAt: writtenAtMicros });
      if (globalEntries.size > maxEntries) {
        while (globalEntries.size > maxEntries - 32) {
          const oldest = globalEntries.keys().next().value;
          globalEntries.delete(oldest);
        }
      }
    },
    get size() {
      return globalEntries.size;
    },
    clear() {
      globalEntries.clear();
    },
  };
}

export function getTimsliteRetentionDays(env = process.env) {
  const raw = env.OBSERVABILITY_TIMSLITE_RETENTION_DAYS;
  if (raw === undefined || raw === null) return DEFAULT_RETENTION_DAYS;

  const trimmed = String(raw).trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return DEFAULT_RETENTION_DAYS;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_RETENTION_DAYS;

  return value;
}

function parsePositiveIntegerSeconds(raw, fallbackSeconds) {
  if (raw === undefined || raw === null) return fallbackSeconds;

  const trimmed = String(raw).trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return fallbackSeconds;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return fallbackSeconds;

  return value;
}

export function getTimsliteFlushIntervalMs(env = process.env) {
  const seconds = parsePositiveIntegerSeconds(
    env.OBSERVABILITY_TIMSLITE_FLUSH_INTERVAL_SECONDS,
    DEFAULT_FLUSH_INTERVAL_SECONDS,
  );
  return seconds * 1000;
}

function daysToMicroseconds(days) {
  return BigInt(days) * 24n * 60n * 60n * 1_000_000n;
}

export function createMonotonicMicrosecondId(clock = Date.now) {
  let lastId = 0n;
  return {
    next() {
      const nowMicros = BigInt(clock()) * 1000n;
      const candidate = nowMicros > lastId ? nowMicros : lastId + 1n;
      lastId = candidate;
      return candidate;
    },
    seedFrom(timestamp) {
      const ts = BigInt(timestamp);
      if (ts > lastId) lastId = ts;
    },
  };
}

function utf8ByteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

function truncateStringToUtf8Budget(str, maxBytes) {
  let low = 0;
  let high = str.length;
  let best = "";
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const slice = str.slice(0, mid);
    const bytes = utf8ByteLength(slice);
    if (bytes <= maxBytes) {
      best = slice;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function truncateUtf8Json(value, maxBytes = TIMSLITE_RECORD_SAFE_BYTES) {
  if (maxBytes < MIN_TRUNCATION_MARKER_BYTES) {
    throw new RangeError(`maxBytes ${maxBytes} is below minimum truncation marker size ${MIN_TRUNCATION_MARKER_BYTES}`);
  }

  const fullSerialized = JSON.stringify(value);
  const originalBytes = utf8ByteLength(fullSerialized);
  if (originalBytes <= maxBytes) return fullSerialized;

  const clone = structuredClone(value);
  const envelope = { __truncated: true, __originalBytes: originalBytes };

  for (const field of TRUNCATABLE_FIELDS) {
    if (clone[field] !== undefined) {
      const fieldSerialized = JSON.stringify(clone[field]);
      const fieldBytes = utf8ByteLength(fieldSerialized);
      clone[field] = {
        __truncated: true,
        __originalBytes: fieldBytes,
        __preview: truncateStringToUtf8Budget(fieldSerialized, 256),
      };
    }
  }

  const withTruncatedFields = JSON.stringify({ ...envelope, ...clone });
  if (utf8ByteLength(withTruncatedFields) <= maxBytes) return withTruncatedFields;

  const minimalEnvelope = JSON.stringify(envelope);
  if (utf8ByteLength(minimalEnvelope) <= maxBytes) return minimalEnvelope;

  return JSON.stringify({ __truncated: true });
}

// Deliberately strict: only literal "true" opts in; "TRUE"/" true "/"1" stay inline.
export function isTimsliteDataStoreEnabled(env = process.env) {
  return env.OBSERVABILITY_TIMSLITE_DATA_STORE === "true";
}

function isValidDecimalId(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

// Replaces each item in request/providerRequest messages/tools with a ref.
// Local first occurrence: "#/0/{sha}" and value added to __values__[sha].
// Cross-record cache hit: "#/{timslite_id}/{sha}" (no local value stored).
// __values__ is an object map { [sha256]: originalItemValue }.
// A payload that already occupies the top-level __values__ key is left
// completely untouched (fail open) so no payload data is overwritten or lost.
function deduplicateMessages(original, cache) {
  if (Object.prototype.hasOwnProperty.call(original, VALUES_KEY)) {
    return { record: original, commits: [] };
  }

  const clone = structuredClone(original);
  const values = Object.create(null);
  const localShas = new Set();
  const commits = [];

  for (const field of DEDUP_FIELDS) {
    const container = clone[field];
    if (!container || typeof container !== "object") continue;

    // messages: per-item dedup (each element → individual ref)
    if (Array.isArray(container.messages)) {
      const items = container.messages;
      for (let i = 0; i < items.length; i += 1) {
        if (typeof items[i] === "string" && TIMSLITE_VALUE_REF_PATTERN.test(items[i])) {
          continue;
        }

        let serialized;
        try {
          serialized = JSON.stringify(items[i]);
        } catch {
          continue;
        }
        if (serialized === undefined) continue;

        const sha = sha256Hex(serialized);

        if (localShas.has(sha) || sha in values) {
          items[i] = `#/0/${sha}`;
          continue;
        }

        const cachedTimsliteId = cache ? cache.getTimsliteId(sha) : undefined;
        if (cachedTimsliteId !== undefined) {
          items[i] = `#/${cachedTimsliteId}/${sha}`;
          continue;
        }

        values[sha] = structuredClone(items[i]);
        localShas.add(sha);
        commits.push({ sha });
        items[i] = `#/0/${sha}`;
      }
    }

    // tools: whole-array dedup (entire array → single ref string)
    if (typeof container.tools === "string" && TIMSLITE_VALUE_REF_PATTERN.test(container.tools)) {
      // already a strict ref string — pass through
    } else if (Array.isArray(container.tools)) {
      let serialized;
      try {
        serialized = JSON.stringify(container.tools);
      } catch {
        // fail open — leave as-is
      }

      if (serialized !== undefined) {
        const sha = sha256Hex(serialized);

        if (localShas.has(sha) || sha in values) {
          container.tools = `#/0/${sha}`;
        } else {
          const cachedTimsliteId = cache ? cache.getTimsliteId(sha) : undefined;
          if (cachedTimsliteId !== undefined) {
            container.tools = `#/${cachedTimsliteId}/${sha}`;
          } else {
            values[sha] = structuredClone(container.tools);
            localShas.add(sha);
            commits.push({ sha });
            container.tools = `#/0/${sha}`;
          }
        }
      }
    }
  }

  if (localShas.size > 0) clone[VALUES_KEY] = values;
  return { record: clone, commits };
}

// Resolves refs in a single record's messages/tools using the record's own
// __values__ plus batch-fetched cross-record payloads. No hash recomputation on
// read, and no ref is ever rewritten to another form: unknown refs fail open.
// Only a well-formed protocol map is consumed and removed; any other shape that
// a payload happens to occupy at __values__ is left untouched.
async function resolveMessages(record, dataset, log) {
  const rawValues = record[VALUES_KEY];
  const hasValidLocalValues = typeof rawValues === "object" && rawValues !== null && !Array.isArray(rawValues);
  const values = hasValidLocalValues ? rawValues : {};

  let hasLocalRef = false;
  const crossRecordRefs = [];
  for (const field of DEDUP_FIELDS) {
    const container = record[field];
    if (!container || typeof container !== "object") continue;

    // messages: scan per-item refs in arrays
    if (Array.isArray(container.messages)) {
      for (const ref of container.messages) {
        if (typeof ref !== "string") continue;
        const match = TIMSLITE_VALUE_REF_PATTERN.exec(ref);
        if (!match) continue;
        if (match[1] === "0") {
          hasLocalRef = true;
        } else {
          crossRecordRefs.push({ id: match[1], sha: match[2] });
        }
      }
    }

    // tools: scan whole-array ref string
    if (typeof container.tools === "string") {
      const match = TIMSLITE_VALUE_REF_PATTERN.exec(container.tools);
      if (match) {
        if (match[1] === "0") {
          hasLocalRef = true;
        } else {
          crossRecordRefs.push({ id: match[1], sha: match[2] });
        }
      }
    }
  }

  let crossValues = null;
  if (crossRecordRefs.length > 0 && dataset) {
    const uniqueIds = [...new Set(crossRecordRefs.map((r) => r.id))];
    const fetched = new Map();
    for (const id of uniqueIds) {
      try {
        const ts = BigInt(id);
        const rec = await dataset.read(ts);
        if (rec) {
          const parsed = JSON.parse(rec[1].toString("utf8"));
          if (typeof parsed[VALUES_KEY] === "object" && parsed[VALUES_KEY] !== null && !Array.isArray(parsed[VALUES_KEY])) {
            fetched.set(id, parsed[VALUES_KEY]);
          }
        }
      } catch (err) {
        log.warn("timslite.crossRecordRead", { id, error: err.message });
      }
    }
    if (fetched.size > 0) crossValues = fetched;
  }

  for (const field of DEDUP_FIELDS) {
    const container = record[field];
    if (!container || typeof container !== "object") continue;

    // messages: per-item resolve
    if (Array.isArray(container.messages)) {
      const items = container.messages;
      for (let i = 0; i < items.length; i += 1) {
        const ref = items[i];
        if (typeof ref !== "string") continue;
        const match = TIMSLITE_VALUE_REF_PATTERN.exec(ref);
        if (!match) continue;
        const id = match[1];
        const sha = match[2];
        if (id === "0") {
          if (sha in values) {
            items[i] = values[sha];
          }
        } else if (crossValues) {
          const sourceValues = crossValues.get(id);
          if (sourceValues && sha in sourceValues) {
            items[i] = sourceValues[sha];
          }
        }
      }
    }

    // tools: whole-array ref resolve
    if (typeof container.tools === "string") {
      const match = TIMSLITE_VALUE_REF_PATTERN.exec(container.tools);
      if (match) {
        const id = match[1];
        const sha = match[2];
        if (id === "0") {
          if (sha in values) {
            container.tools = values[sha];
          }
        } else if (crossValues) {
          const sourceValues = crossValues.get(id);
          if (sourceValues && sha in sourceValues) {
            container.tools = sourceValues[sha];
          }
        }
      }
    }
  }

  if (hasValidLocalValues && hasLocalRef) delete record[VALUES_KEY];
  return record;
}

async function createDefaultAdapter() {
  const timslite = await import("timslite");
  return {
    async openStore(dataDir, config) {
      const store = timslite.Store.open(dataDir, config);
      return {
        async createDataset(name, type, options) {
          store.createDataset(name, type, options);
        },
        async openDataset(name, type) {
          const dataset = store.openDataset(name, type);
          return {
            async write(timestamp, data) {
              dataset.write(BigInt(timestamp), data);
            },
            async read(timestamp) {
              return dataset.read(BigInt(timestamp));
            },
            async readLatest() {
              return dataset.readLatest();
            },
            async flush() {
              
            },
            async close() {
              dataset.close();
            },
          };
        },
        async close() {
          store.close();
        },
      };
    },
  };
}

export function createRequestDetailsStore({ adapter, env = process.env, clock, logger } = {}) {
  const enabled = isTimsliteDataStoreEnabled(env);
  const idGen = createMonotonicMicrosecondId(clock);
  const retentionDays = getTimsliteRetentionDays(env);
  const retentionWindow = daysToMicroseconds(retentionDays);
  const flushIntervalMs = getTimsliteFlushIntervalMs(env);
  const log = logger || { warn: () => {} };

  const crossRecordTtlMicroseconds = computeCrossRecordTtlMicroseconds(retentionWindow);
  const valueCache = createValueCache({ ttlMicroseconds: crossRecordTtlMicroseconds, clock });

  let store = null;
  let dataset = null;
  let initialized = false;
  let closed = false;
  let initPromise = null;
  const staged = [];

  async function initialize() {
    if (closed) return null;
    if (initialized) return { store, dataset };
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const adapterImpl = adapter || await createDefaultAdapter();
      store = await adapterImpl.openStore(TIMSLITE_REQUEST_DETAILS_PATH, { readOnly: false, flushIntervalMs });
      if (store.readOnly === true) {
        throw new Error("Timslite store opened in read-only mode; cannot write request details");
      }
      try {
        await store.createDataset(DATASET_NAME, DATASET_TYPE, { retentionWindow: retentionWindow, indexContinuous: false, enableJournal: false });
      } catch (err) {
        log.warn("timslite.createDataset", { error: err.message });
      }
      dataset = await store.openDataset(DATASET_NAME, DATASET_TYPE);
      const latest = await dataset.readLatest();
      if (latest) {
        idGen.seedFrom(latest[0]);
      }
      initialized = true;
      return { store, dataset };
    })();

    return initPromise;
  }

  async function initializeReadOnly() {
    if (closed) return null;
    if (dataset) return { store, dataset };
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const adapterImpl = adapter || await createDefaultAdapter();
      store = await adapterImpl.openStore(TIMSLITE_REQUEST_DETAILS_PATH, { readOnly: true });
      try {
        dataset = await store.openDataset(DATASET_NAME, DATASET_TYPE);
      } catch (err) {
        log.warn("timslite.openDataset.readOnly", { error: err.message });
        return null;
      }
      return { store, dataset };
    })();

    return initPromise;
  }

  async function stage(detail) {
    if (!enabled) return null;
    await initialize();
    const id = idGen.next();
    const cloned = structuredClone(detail);
    staged.push({ id, original: cloned });
    return { timslite_id: id.toString() };
  }

  function serializeForWrite(original) {
    try {
      const { record, commits } = deduplicateMessages(original, valueCache);
      const compressed = JSON.stringify(record);
      if (utf8ByteLength(compressed) <= TIMSLITE_RECORD_SAFE_BYTES) {
        return { value: compressed, commits };
      }
    } catch (err) {
      log.warn("timslite.compress", { error: err.message });
    }
    return { value: truncateUtf8Json(original), commits: [] };
  }

  async function flush() {
    if (!enabled) return;
    if (staged.length === 0) {
      await initialize();
      if (dataset) await dataset.flush();
      return;
    }
    await initialize();
    for (let idx = 0; idx < staged.length; idx += 1) {
      const { id, original } = staged[idx];
      const nowMicros = BigInt(clock ? clock() : Date.now()) * 1000n;

      // Update staged record to replace local refs with cross-record refs
      // for SHAs already written by earlier records in this flush batch.
      const recordForWrite = updateStagedRefs(original);
      const { value, commits } = serializeForWrite(recordForWrite);
      await dataset.write(id, Buffer.from(value, "utf8"));
      for (const { sha } of commits) {
        valueCache.setTimsliteId(sha, id.toString(), nowMicros);
      }
    }
    await dataset.flush();
    staged.length = 0;
  }

  // Replace #/0/{sha} refs with #/{timslite_id}/{sha} when the SHA was
  // cached by a previously written record in the same flush batch.
  function updateStagedRefs(original) {
    let modified = false;
    const clone = structuredClone(original);
    for (const field of DEDUP_FIELDS) {
      const container = clone[field];
      if (!container || typeof container !== "object") continue;

      // messages: per-item ref update
      if (Array.isArray(container.messages)) {
        const items = container.messages;
        for (let i = 0; i < items.length; i += 1) {
          const ref = items[i];
          if (typeof ref !== "string") continue;
          const match = TIMSLITE_VALUE_REF_PATTERN.exec(ref);
          if (!match || match[1] !== "0") continue;
          const cachedId = valueCache.getTimsliteId(match[2]);
          if (cachedId !== undefined) {
            items[i] = `#/${cachedId}/${match[2]}`;
            modified = true;
          }
        }
      }

      // tools: whole-array ref string update
      if (typeof container.tools === "string") {
        const match = TIMSLITE_VALUE_REF_PATTERN.exec(container.tools);
        if (match && match[1] === "0") {
          const cachedId = valueCache.getTimsliteId(match[2]);
          if (cachedId !== undefined) {
            container.tools = `#/${cachedId}/${match[2]}`;
            modified = true;
          }
        }
      }
    }
    return modified ? clone : original;
  }

  async function discard() {
    staged.length = 0;
  }

  async function getMany(ids) {
    const result = new Map();
    if (ids.length === 0) return result;

    const validIds = [];
    for (const id of ids) {
      if (isValidDecimalId(id)) {
        validIds.push(id);
        result.set(id, null);
      } else {
        result.set(id, null);
      }
    }

    const unique = [...new Set(validIds)];
    if (unique.length === 0) return result;

    try {
      if (!dataset) {
        if (enabled) {
          await initialize();
        } else {
          await initializeReadOnly();
        }
      }
      if (!dataset) return result;

      for (const id of unique) {
        try {
          const ts = BigInt(id);
          const record = await dataset.read(ts);
          if (!record) {
            continue;
          }
          const parsed = await resolveMessages(JSON.parse(record[1].toString("utf8")), dataset, log);
          result.set(id, parsed);
        } catch (err) {
          log.warn("timslite.read", { id, error: err.message });
        }
      }
    } catch (err) {
      log.warn("timslite.getMany", { error: err.message });
    }

    return result;
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (dataset) {
      try {
        await dataset.close();
      } catch (err) {
        log.warn("timslite.close.dataset", { error: err.message });
      }
      dataset = null;
    }
    if (store) {
      try {
        await store.close();
      } catch (err) {
        log.warn("timslite.close.store", { error: err.message });
      }
      store = null;
    }
  }

  return { enabled, stage, flush, discard, getMany, close };
}
