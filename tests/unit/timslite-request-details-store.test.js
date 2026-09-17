import path from "node:path";
import { describe, expect, it } from "vitest";
import { DB_DIR, TIMSLITE_REQUEST_DETAILS_PATH } from "@/lib/db/paths.js";
import {
  TIMSLITE_RECORD_MAX_BYTES,
  TIMSLITE_RECORD_SAFE_BYTES,
  createMonotonicMicrosecondId,
  createRequestDetailsStore,
  getTimsliteRetentionDays,
  isTimsliteDataStoreEnabled,
  truncateUtf8Json,
} from "@/lib/timslite/requestDetailsStore.js";

function makeFakeAdapter(options = {}) {
  const records = new Map();
  const calls = {
    storeOpen: [],
    createDataset: [],
    openDataset: [],
    write: [],
    read: [],
    readLatest: 0,
    flush: 0,
    close: 0,
  };
  let latestTimestamp = 0n;
  const forceReadOnly = options.forceReadOnly || false;
  return {
    calls,
    records,
    setLatestTimestamp(ts) {
      latestTimestamp = BigInt(ts);
      if (!records.has(latestTimestamp.toString())) {
        records.set(latestTimestamp.toString(), JSON.stringify({ __seed: true }));
      }
    },
    adapter: {
      async openStore(dataDir, config) {
        calls.storeOpen.push({ dataDir, config });
        const isReadOnly = forceReadOnly || (config && config.readOnly === true);
        return {
          readOnly: isReadOnly,
          async createDataset(name, type, options) {
            calls.createDataset.push({ name, type, options });
          },
          async openDataset(name, type) {
            calls.openDataset.push({ name, type });
            return {
              async write(timestamp, data) {
                calls.write.push({ timestamp: BigInt(timestamp), data });
                const ts = BigInt(timestamp);
                records.set(ts.toString(), data.toString("utf8"));
                if (ts > latestTimestamp) latestTimestamp = ts;
              },
              async read(timestamp) {
                calls.read.push(BigInt(timestamp));
                const ts = BigInt(timestamp);
                const value = records.get(ts.toString());
                if (value === undefined) return null;
                return [ts, Buffer.from(value, "utf8")];
              },
              async readLatest() {
                calls.readLatest += 1;
                if (latestTimestamp === 0n) return null;
                const value = records.get(latestTimestamp.toString());
                if (value === undefined) return null;
                return [latestTimestamp, Buffer.from(value, "utf8")];
              },
              async flush() { calls.flush += 1; },
              async close() { calls.close += 1; },
            };
          },
          async close() { calls.close += 1; },
        };
      },
    },
  };
}

describe("Timslite request-details configuration", () => {
  it("uses the SQLite sibling request-details path", () => {
    expect(TIMSLITE_REQUEST_DETAILS_PATH).toBe(path.join(DB_DIR, "timslite", "9router"));
  });

  it.each([undefined, "", "0", "-3", "1.5", "30days", "not-a-number"])("defaults invalid retention %j to 90 days", (value) => {
    expect(getTimsliteRetentionDays({ OBSERVABILITY_TIMSLITE_RETENTION_DAYS: value })).toBe(90);
  });

  it("uses a positive whole-day retention value", () => {
    expect(getTimsliteRetentionDays({ OBSERVABILITY_TIMSLITE_RETENTION_DAYS: "30" })).toBe(30);
  });
});

describe("isTimsliteDataStoreEnabled — literal-only gate", () => {
  it.each([
    ["true", true],
    ["TRUE", false],
    ["True", false],
    ["tRuE", false],
    [" true", false],
    ["true ", false],
    [" true ", false],
    ["1", false],
    ["0", false],
    ["yes", false],
    ["", false],
  ])("value %j → enabled %s", (value, expected) => {
    expect(isTimsliteDataStoreEnabled({ OBSERVABILITY_TIMSLITE_DATA_STORE: value })).toBe(expected);
  });

  it("returns false when the variable is absent, undefined, or null", () => {
    expect(isTimsliteDataStoreEnabled({})).toBe(false);
    expect(isTimsliteDataStoreEnabled({ OBSERVABILITY_TIMSLITE_DATA_STORE: undefined })).toBe(false);
    expect(isTimsliteDataStoreEnabled({ OBSERVABILITY_TIMSLITE_DATA_STORE: null })).toBe(false);
  });

  it("defaults to process.env and restores it afterwards", () => {
    const original = process.env.OBSERVABILITY_TIMSLITE_DATA_STORE;
    try {
      process.env.OBSERVABILITY_TIMSLITE_DATA_STORE = "true";
      expect(isTimsliteDataStoreEnabled()).toBe(true);
      process.env.OBSERVABILITY_TIMSLITE_DATA_STORE = "TRUE";
      expect(isTimsliteDataStoreEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.OBSERVABILITY_TIMSLITE_DATA_STORE;
      else process.env.OBSERVABILITY_TIMSLITE_DATA_STORE = original;
    }
  });
});

describe("Timslite request-details store", () => {
  it("exposes a 4 MiB record cap constant", () => {
    expect(TIMSLITE_RECORD_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it("keeps the serialization budget below the hard record cap", () => {
    expect(TIMSLITE_RECORD_SAFE_BYTES).toBe(TIMSLITE_RECORD_MAX_BYTES - 64 * 1024);
  });

  it.each([undefined, "", "false", "0", "1", "yes", "True", "TRUE", " true", "true ", " true ", "TRUE ", "tRuE"])(
    "is disabled unless OBSERVABILITY_TIMSLITE_DATA_STORE is the literal string true (%j)",
    (value) => {
      const fake = makeFakeAdapter();
      const store = createRequestDetailsStore({ adapter: fake.adapter, env: { OBSERVABILITY_TIMSLITE_DATA_STORE: value } });
      expect(store.enabled).toBe(false);
    }
  );

  it("is enabled only for the exact literal string true", () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({ adapter: fake.adapter, env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" } });
    expect(store.enabled).toBe(true);
  });

  it("disabled store does not open the dataset on flush", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({ adapter: fake.adapter, env: {} });
    expect(store.enabled).toBe(false);
    await store.flush();
    expect(fake.calls.storeOpen).toEqual([]);
    expect(fake.calls.flush).toBe(0);
  });

  it("opens local 9router/requestDetails with the configured path and configures 90-day retention", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "detail-a", request: { body: "hello" } });
    await store.flush();
    expect(fake.calls.storeOpen).toHaveLength(1);
    expect(fake.calls.storeOpen[0].dataDir).toBe(TIMSLITE_REQUEST_DETAILS_PATH);
    expect(fake.calls.createDataset).toHaveLength(1);
    expect(fake.calls.createDataset[0]).toMatchObject({
      name: "requestDetails",
      type: "raw",
    });
    expect(fake.calls.createDataset[0].options.retentionWindow).toBe(90n * 24n * 60n * 60n * 1_000_000n);
  });

  it("uses a custom retention when configured", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true", OBSERVABILITY_TIMSLITE_RETENTION_DAYS: "30" },
    });
    await store.stage({ id: "x" });
    await store.flush();
    expect(fake.calls.createDataset[0].options.retentionWindow).toBe(30n * 24n * 60n * 60n * 1_000_000n);
  });

  it("stage returns exactly { timslite_id } as a decimal string pointer with no metadata", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const pointer = await store.stage({ id: "a", request: { body: "hello" } });
    expect(Object.keys(pointer)).toEqual(["timslite_id"]);
    expect(pointer.timslite_id).toMatch(/^\d+$/);
    expect(typeof pointer.timslite_id).toBe("string");
  });

  it("writes staged values then issues exactly one flush for the batch", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a", request: { x: 1 } });
    await store.stage({ id: "b", response: { y: 2 } });
    await store.flush();
    expect(fake.calls.write).toHaveLength(2);
    expect(fake.calls.flush).toBe(1);
  });

  it("does not call delete at any point", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.flush();
    await store.close();
    expect(fake.calls.write).toHaveLength(1);
  });

  it("flush with no staged records still opens and configures retention but does not write", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.flush();
    expect(fake.calls.storeOpen).toHaveLength(1);
    expect(fake.calls.createDataset).toHaveLength(1);
    expect(fake.calls.write).toHaveLength(0);
    expect(fake.calls.flush).toBe(1);
  });

  it("does not mutate the caller's detail object", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const detail = { id: "a", request: { body: "hello" } };
    const snapshot = JSON.parse(JSON.stringify(detail));
    await store.stage(detail);
    expect(detail).toEqual(snapshot);
  });

  it("stored values are JSON parseable", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a", request: { body: "hello" } });
    await store.flush();
    for (const value of fake.records.values()) {
      expect(() => JSON.parse(value)).not.toThrow();
    }
  });
});

describe("Monotonic microsecond IDs", () => {
  it("generates strictly increasing decimal bigint microsecond IDs from a fixed clock", () => {
    const idGen = createMonotonicMicrosecondId(() => 1_726_480_000_000);
    const ids = [idGen.next().toString(), idGen.next().toString(), idGen.next().toString()];
    expect(ids).toEqual(ids.map(() => expect.stringMatching(/^\d+$/)));
    expect(BigInt(ids[1])).toBeGreaterThan(BigInt(ids[0]));
    expect(BigInt(ids[2])).toBeGreaterThan(BigInt(ids[1]));
  });

  it("remains strictly increasing even when the clock moves backward", () => {
    let now = 2_000_000_000_000;
    const idGen = createMonotonicMicrosecondId(() => now);
    const first = idGen.next().toString();
    now = 1_000_000_000_000;
    const second = idGen.next().toString();
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
  });

  it("produces IDs based on microsecond scaling of the clock value", () => {
    const idGen = createMonotonicMicrosecondId(() => 1_726_480_000_000);
    const id = idGen.next().toString();
    expect(BigInt(id)).toBe(1_726_480_000_000_000n);
  });
});

describe("UTF-8 JSON truncation", () => {
  it("returns small payloads unchanged", () => {
    const payload = { request: { body: "hello" } };
    const result = truncateUtf8Json(payload);
    expect(JSON.parse(result)).toEqual(payload);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(TIMSLITE_RECORD_MAX_BYTES);
  });

  it("truncates oversized payloads while keeping JSON parseable", () => {
    const bigString = "x".repeat(5 * 1024 * 1024);
    const payload = { request: { body: bigString }, id: "keep-me" };
    const result = truncateUtf8Json(payload);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(TIMSLITE_RECORD_MAX_BYTES);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.id).toBe("keep-me");
  });

  it("stores a near-boundary payload within the safe budget and below the hard cap", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ request: { body: "x".repeat(TIMSLITE_RECORD_MAX_BYTES) } });
    await store.flush();

    const stored = fake.calls.write[0].data;
    expect(stored.byteLength).toBeLessThan(TIMSLITE_RECORD_MAX_BYTES);
    expect(stored.byteLength).toBeLessThanOrEqual(TIMSLITE_RECORD_SAFE_BYTES);
  });

  it("truncation result includes a stable marker and original byte count", () => {
    const bigString = "x".repeat(5 * 1024 * 1024);
    const payload = { request: { body: bigString } };
    const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const result = truncateUtf8Json(payload);
    const parsed = JSON.parse(result);
    expect(parsed.__truncated).toBe(true);
    expect(parsed.__originalBytes).toBe(originalBytes);
  });

  it("handles multi-byte UTF-8 characters without splitting surrogate pairs", () => {
    const emoji = "😀";
    const payload = { request: { body: emoji.repeat(1_200_000) } };
    const result = truncateUtf8Json(payload);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(TIMSLITE_RECORD_MAX_BYTES);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("throws RangeError when minimum marker cannot fit", () => {
    const payload = { id: "test" };
    expect(() => truncateUtf8Json(payload, 5)).toThrow(RangeError);
  });
});

describe("getMany bounded point reads", () => {
  it("reads each unique requested pointer once and returns a Map", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const p1 = await store.stage({ id: "a" });
    const p2 = await store.stage({ id: "b" });
    await store.flush();

    const result = await store.getMany([p1.timslite_id, p2.timslite_id]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get(p1.timslite_id)).toEqual({ id: "a" });
    expect(result.get(p2.timslite_id)).toEqual({ id: "b" });
    expect(fake.calls.read).toHaveLength(2);
  });

  it("deduplicates repeated IDs", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const p1 = await store.stage({ id: "a" });
    await store.flush();

    await store.getMany([p1.timslite_id, p1.timslite_id, p1.timslite_id]);
    expect(fake.calls.read).toHaveLength(1);
  });

  it("maps missing records to null", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const result = await store.getMany(["999999"]);
    expect(result.get("999999")).toBeNull();
  });

  it("maps malformed JSON to null", async () => {
    const fake = makeFakeAdapter();
    fake.records.set("999999", "not-json{{{");
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const result = await store.getMany(["999999"]);
    expect(result.get("999999")).toBeNull();
  });

  it("maps per-record read failures to null without throwing", async () => {
    const fake = makeFakeAdapter();
    const originalOpenDataset = fake.adapter.openStore;
    fake.adapter.openStore = async (dataDir, config) => {
      const store = await originalOpenDataset(dataDir, config);
      const origOpenDataset = store.openDataset.bind(store);
      store.openDataset = async (name, type) => {
        const ds = await origOpenDataset(name, type);
        const origRead = ds.read.bind(ds);
        ds.read = async (timestamp) => {
          if (timestamp === 888888n) throw new Error("read failure");
          return origRead(timestamp);
        };
        return ds;
      };
      return store;
    };
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const p1 = await store.stage({ id: "ok" });
    await store.flush();

    const result = await store.getMany([p1.timslite_id, "888888"]);
    expect(result.get(p1.timslite_id)).toEqual({ id: "ok" });
    expect(result.get("888888")).toBeNull();
  });

  it("preserves string IDs in the returned Map", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const p1 = await store.stage({ id: "a" });
    await store.flush();

    const result = await store.getMany([p1.timslite_id]);
    for (const key of result.keys()) {
      expect(typeof key).toBe("string");
    }
  });

  it("returns empty Map for empty input", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const result = await store.getMany([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("validates decimal IDs and rejects non-decimal strings", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const result = await store.getMany(["abc", "12.5", "-1", "1e10"]);
    expect(result.get("abc")).toBeNull();
    expect(result.get("12.5")).toBeNull();
    expect(result.get("-1")).toBeNull();
    expect(result.get("1e10")).toBeNull();
  });
});

describe("Idempotent close", () => {
  it("close is idempotent - calling twice closes the dataset once", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.flush();
    await store.close();
    await store.close();
    await store.close();
    expect(fake.calls.close).toBe(2);
  });

  it("close on disabled store is a no-op", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({ adapter: fake.adapter, env: {} });
    await store.close();
    expect(fake.calls.close).toBe(0);
    expect(fake.calls.storeOpen).toEqual([]);
  });

  it("close does not implicitly flush staged records", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.close();
    expect(fake.calls.write).toHaveLength(0);
    expect(fake.calls.flush).toBe(0);
  });
});

describe("Official Timslite API adapter", () => {
  it("uses Store.open, createDataset, and dataset operations", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.flush();
    expect(fake.calls.storeOpen).toHaveLength(1);
    expect(fake.calls.createDataset).toHaveLength(1);
    expect(fake.calls.write).toHaveLength(1);
    expect(fake.calls.flush).toBe(1);
  });

  it("write uses bigint timestamp and Buffer data", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.flush();
    expect(fake.calls.write[0].timestamp).toEqual(expect.any(BigInt));
    expect(fake.calls.write[0].data).toBeInstanceOf(Buffer);
  });

  it("retentionWindow is in microseconds", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true", OBSERVABILITY_TIMSLITE_RETENTION_DAYS: "1" },
    });
    await store.stage({ id: "a" });
    await store.flush();
    expect(fake.calls.createDataset[0].options.retentionWindow).toBe(86_400_000_000n);
  });
});

describe("Writable mode and read-only fallback", () => {
  it("writable mode required for writes", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.flush();
    expect(fake.calls.write).toHaveLength(1);
  });

  it("read-only fallback never emits pointers", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: {},
    });
    expect(store.enabled).toBe(false);
    const pointer = await store.stage({ id: "a" });
    expect(pointer).toBeNull();
    await store.flush();
    expect(fake.calls.write).toHaveLength(0);
  });
});

describe("Explicit writable-store semantics", () => {
  it("write initialization passes readOnly: false", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    expect(fake.calls.storeOpen).toHaveLength(1);
    expect(fake.calls.storeOpen[0].config).toEqual({ readOnly: false });
  });

  it("stage rejects if returned store is read-only", async () => {
    const fake = makeFakeAdapter({ forceReadOnly: true });
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await expect(store.stage({ id: "a" })).rejects.toThrow(/read.?only/i);
    expect(fake.calls.write).toHaveLength(0);
  });

  it("stage rejects before ID/pointer creation when store is read-only", async () => {
    const fake = makeFakeAdapter({ forceReadOnly: true });
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    let pointer = "not-called";
    try {
      pointer = await store.stage({ id: "a" });
    } catch (err) {
      expect(err.message).toMatch(/read.?only/i);
    }
    expect(pointer).toBe("not-called");
    expect(fake.calls.write).toHaveLength(0);
  });

  it("read-only hydration passes readOnly: true", async () => {
    const fake = makeFakeAdapter();
    fake.records.set("123456", JSON.stringify({ id: "test" }));
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: {},
    });
    await store.getMany(["123456"]);
    expect(fake.calls.storeOpen).toHaveLength(1);
    expect(fake.calls.storeOpen[0].config).toEqual({ readOnly: true });
  });
});

describe("Latest timestamp recovery", () => {
  it("first write initializes from readLatest() timestamp", async () => {
    const fake = makeFakeAdapter();
    fake.setLatestTimestamp(1_000_000_000_000_000n);
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const pointer = await store.stage({ id: "a" });
    expect(BigInt(pointer.timslite_id)).toBeGreaterThan(1_000_000_000_000_000n);
    expect(fake.calls.readLatest).toBe(1);
  });

  it("allocates strictly larger ID than readLatest()", async () => {
    const fake = makeFakeAdapter();
    fake.setLatestTimestamp(2_000_000_000_000_000n);
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const p1 = await store.stage({ id: "a" });
    const p2 = await store.stage({ id: "b" });
    expect(BigInt(p2.timslite_id)).toBeGreaterThan(BigInt(p1.timslite_id));
    expect(BigInt(p1.timslite_id)).toBeGreaterThan(2_000_000_000_000_000n);
  });
});

describe("Reads work regardless of write flag", () => {
  it("getMany works when writes are disabled", async () => {
    const fake = makeFakeAdapter();
    fake.records.set("123456", JSON.stringify({ id: "test" }));
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: {},
    });
    expect(store.enabled).toBe(false);
    const result = await store.getMany(["123456"]);
    expect(result.get("123456")).toEqual({ id: "test" });
  });
});

describe("Error handling", () => {
  it("package/init failure returns unavailable reads", async () => {
    const fake = makeFakeAdapter();
    fake.adapter.openStore = async () => {
      throw new Error("package not available");
    };
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const result = await store.getMany(["123"]);
    expect(result.get("123")).toBeNull();
  });

  it("read failure returns null for that record", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    const result = await store.getMany(["999999"]);
    expect(result.get("999999")).toBeNull();
  });

  it("write initialization error propagates", async () => {
    const fake = makeFakeAdapter();
    fake.adapter.openStore = async () => {
      throw new Error("init failed");
    };
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await expect(store.stage({ id: "a" })).rejects.toThrow("init failed");
  });

  it("flush error propagates", async () => {
    const fake = makeFakeAdapter();
    const originalOpenStore = fake.adapter.openStore.bind(fake.adapter);
    fake.adapter.openStore = async (dataDir, config) => {
      const s = await originalOpenStore(dataDir, config);
      const origOpen = s.openDataset.bind(s);
      s.openDataset = async (name, type) => {
        const ds = await origOpen(name, type);
        ds.flush = async () => { throw new Error("flush failed"); };
        return ds;
      };
      return s;
    };
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await expect(store.flush()).rejects.toThrow("flush failed");
  });
});

describe("Concurrent initialization", () => {
  it("shares one promise for concurrent flush calls", async () => {
    const fake = makeFakeAdapter();
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await Promise.all([store.flush(), store.flush(), store.flush()]);
    expect(fake.calls.storeOpen).toHaveLength(1);
  });
});

describe("Staged records removal", () => {
  it("staged records only removed after successful flush", async () => {
    const fake = makeFakeAdapter();
    let flushShouldFail = true;
    const originalOpenStore = fake.adapter.openStore.bind(fake.adapter);
    fake.adapter.openStore = async (dataDir, config) => {
      const s = await originalOpenStore(dataDir, config);
      const origOpen = s.openDataset.bind(s);
      s.openDataset = async (name, type) => {
        const ds = await origOpen(name, type);
        const origFlush = ds.flush.bind(ds);
        ds.flush = async () => {
          if (flushShouldFail) throw new Error("flush failed");
          return origFlush();
        };
        return ds;
      };
      return s;
    };
    const store = createRequestDetailsStore({
      adapter: fake.adapter,
      env: { OBSERVABILITY_TIMSLITE_DATA_STORE: "true" },
    });
    await store.stage({ id: "a" });
    await store.stage({ id: "b" });
    await expect(store.flush()).rejects.toThrow();
    flushShouldFail = false;
    await store.flush();
    expect(fake.calls.write.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Truncation edge cases", () => {
  it("throws RangeError when minimum marker cannot fit", () => {
    const payload = { id: "test" };
    expect(() => truncateUtf8Json(payload, 5)).toThrow(RangeError);
  });

  it("produces valid JSON within budget for oversized non-truncatable metadata", () => {
    const payload = { id: "x".repeat(1000), status: "ok" };
    const result = truncateUtf8Json(payload, 200);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(200);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
