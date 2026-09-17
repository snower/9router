import { TIMSLITE_REQUEST_DETAILS_PATH } from "@/lib/db/paths.js";

const DEFAULT_RETENTION_DAYS = 90;
export const TIMSLITE_RECORD_MAX_BYTES = 4 * 1024 * 1024;
export const TIMSLITE_RECORD_SAFE_BYTES = TIMSLITE_RECORD_MAX_BYTES - 64 * 1024;
const DATASET_NAME = "requestDetails";
const DATASET_TYPE = "raw";
const MIN_TRUNCATION_MARKER_BYTES = Buffer.byteLength(JSON.stringify({ __truncated: true }), "utf8");

const TRUNCATABLE_FIELDS = ["request", "providerRequest", "providerResponse", "response"];

export function getTimsliteRetentionDays(env = process.env) {
  const raw = env.OBSERVABILITY_TIMSLITE_RETENTION_DAYS;
  if (raw === undefined || raw === null) return DEFAULT_RETENTION_DAYS;

  const trimmed = String(raw).trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return DEFAULT_RETENTION_DAYS;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_RETENTION_DAYS;

  return value;
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
  const log = logger || { warn: () => {} };

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
      store = await adapterImpl.openStore(TIMSLITE_REQUEST_DETAILS_PATH, { readOnly: false });
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
    const serialized = truncateUtf8Json(cloned);
    staged.push({ id, value: serialized });
    return { timslite_id: id.toString() };
  }

  async function flush() {
    if (!enabled) return;
    if (staged.length === 0) {
      await initialize();
      if (dataset) await dataset.flush();
      return;
    }
    await initialize();
    for (const { id, value } of staged) {
      await dataset.write(id, Buffer.from(value, "utf8"));
    }
    await dataset.flush();
    staged.length = 0;
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
          const parsed = JSON.parse(record[1].toString("utf8"));
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
