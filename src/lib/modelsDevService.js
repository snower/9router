// Standalone, fail-open models.dev metadata service.
// Fetches https://models.dev/models.json, caches with bounded TTL,
// deduplicates concurrent fetches, exposes lookup by canonical/bare name.
// Never throws at callers — all failures return no-match.

const MODELS_DEV_URL = "https://models.dev/models.json";
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let cachedIndex = null;
let cachedAt = 0;
let pendingFetch = null;

function isValidPayload(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  for (const key of Object.keys(data)) {
    const record = data[key];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return false;
    }
    if (typeof record.id !== "string" || record.id.length === 0) {
      return false;
    }
  }
  return true;
}

function buildIndex(raw) {
  const canonicalMap = new Map();
  const bareMap = new Map();

  for (const [, record] of Object.entries(raw)) {
    const id = record.id;
    canonicalMap.set(id, record);

    const bare = id.includes("/") ? id.split("/").pop() : id;
    if (!bareMap.has(bare)) {
      bareMap.set(bare, id);
    } else {
      bareMap.set(bare, null);
    }
  }

  return { canonicalMap, bareMap };
}

async function doFetch() {
  const res = await fetch(MODELS_DEV_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  

  if (!res.ok) {
    return null;
  }

  const data = await res.json();

  if (!isValidPayload(data)) {
    return null;
  }

  return data;
}

async function fetchAndCache() {
  if (pendingFetch) {
    return pendingFetch;
  }

  pendingFetch = (async () => {
    try {
      const raw = await doFetch();
      if (raw === null) {
        return null;
      }
      cachedIndex = buildIndex(raw);
      cachedAt = Date.now();
      return cachedIndex;
    } catch {
      return null;
    } finally {
      pendingFetch = null;
    }
  })();
  return pendingFetch;
}

function isStale() {
  return Date.now() - cachedAt > CACHE_TTL_MS;
}

export async function findMetadataByName(name) {
  if (!name || typeof name !== "string") {
    return null;
  }

  if (!cachedIndex || isStale()) {
    await fetchAndCache();
    if (!cachedIndex) {
      return null;
    }
  }
  const { canonicalMap, bareMap } = cachedIndex;

  if (canonicalMap.has(name)) {
    return canonicalMap.get(name);
  }

  const canonicalKey = bareMap.get(name);
  if (canonicalKey) {
    return canonicalMap.get(canonicalKey);
  }

  return null;
}

export function resetCacheForTest() {
  cachedIndex = null;
  cachedAt = 0;
  pendingFetch = null;
}
