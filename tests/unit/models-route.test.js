import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(),
}));

vi.mock("@/lib/db/repos/combosRepo.js", () => ({
  getCombos: vi.fn(),
}));

vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/db/repos/aliasRepo.js", () => ({
  getCustomModels: vi.fn().mockResolvedValue([]),
  getModelAliases: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/db/repos/disabledModelsRepo.js", () => ({
  getDisabledModels: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  PROVIDER_ID_TO_ALIAS: {},
  PROVIDER_MODELS: {},
  AI_PROVIDERS: {},
  getProviderAlias: vi.fn().mockReturnValue(null),
  isOpenAICompatibleProvider: vi.fn().mockReturnValue(false),
  isAnthropicCompatibleProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("@/shared/utils/modelCapabilities.js", () => ({
  getCapabilitiesForModel: vi.fn().mockReturnValue(null),
}));

const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
const { getCombos } = await import("@/lib/db/repos/combosRepo.js");
const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { resetCacheForTest } = await import("@/lib/modelsDevService.js");

describe("buildModelsList with exposeComboOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default-off includes Combo and provider model entries", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: false });
    getCombos.mockResolvedValue([
      { name: "my-combo", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([
      {
        provider: "openai",
        isActive: true,
        providerSpecificData: {},
      },
    ]);

    const result = await buildModelsList(["llm"]);

    const comboEntries = result.filter((m) => m.owned_by === "combo");
    const providerEntries = result.filter((m) => m.owned_by !== "combo");

    expect(comboEntries.length).toBeGreaterThan(0);
    expect(providerEntries.length).toBeGreaterThan(0);
  });

  it("enabled returns only kind-matching Combos", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true });
    getCombos.mockResolvedValue([
      { name: "llm-combo", kind: "llm", models: ["gpt-4"] },
      { name: "web-combo", kind: "webSearch", models: ["search-model"] },
    ]);
    getProviderConnections.mockResolvedValue([
      {
        provider: "openai",
        isActive: true,
        providerSpecificData: {},
      },
    ]);

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "llm-combo",
      owned_by: "combo",
    });
  });

  it("enabled with no kind-matching Combo produces empty list", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true });
    getCombos.mockResolvedValue([
      { name: "web-combo", kind: "webSearch", models: ["search-model"] },
    ]);
    getProviderConnections.mockResolvedValue([
      {
        provider: "openai",
        isActive: true,
        providerSpecificData: {},
      },
    ]);

    const result = await buildModelsList(["llm"]);

    expect(result).toEqual([]);
  });

  it("enabled with web kind filter returns only webSearch/webFetch Combos and preserves kind field", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true });
    getCombos.mockResolvedValue([
      { name: "llm-combo", kind: "llm", models: ["gpt-4"] },
      { name: "search-combo", kind: "webSearch", models: ["search-model"] },
      { name: "fetch-combo", kind: "webFetch", models: ["fetch-model"] },
    ]);
    getProviderConnections.mockResolvedValue([]);

    const result = await buildModelsList(["webSearch", "webFetch"], { exposeComboOnly: true });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "search-combo",
      owned_by: "combo",
      kind: "webSearch",
    });
    expect(result[1]).toMatchObject({
      id: "fetch-combo",
      owned_by: "combo",
      kind: "webFetch",
    });
    expect(result.every((m) => m.owned_by === "combo")).toBe(true);
    expect(result.every((m) => m.kind === "webSearch" || m.kind === "webFetch")).toBe(true);
  });
});

describe("buildModelsList with infoFromModelsDev", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCacheForTest();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it("enriches Combo entry with models_dev_id when exact full ID matches", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: true });
    getCombos.mockResolvedValue([
      { name: "openai/gpt-4o", kind: "llm", models: ["gpt-4o"] },
    ]);
    getProviderConnections.mockResolvedValue([]);
    // models.dev returns a keyed object: { "<vendor>/<model>": { id, name, description, ... } }
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        "openai/gpt-4o": {
          id: "openai/gpt-4o",
          name: "GPT-4 Optimized",
          description: "A powerful multimodal model",
        },
      }),
    });

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    // Combo id/object/owned_by must be preserved exactly
    expect(result[0].id).toBe("openai/gpt-4o");
    expect(result[0].object).toBe("model");
    expect(result[0].owned_by).toBe("combo");
    // models_dev_id metadata from models.dev canonical key
    expect(result[0].models_dev_id).toBe("openai/gpt-4o");
    // Whitelisted fields copied from models.dev record
    expect(result[0].name).toBe("GPT-4 Optimized");
    expect(result[0].description).toBe("A powerful multimodal model");
    // display_name must never overwrite combo routing identity
    expect(result[0].display_name).toBeUndefined();
  });

  it("enriches Combo entry with models_dev_id when bare name matches unique final slash", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: true });
    getCombos.mockResolvedValue([
      { name: "my-combo", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([]);
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        "vendor-xyz/my-combo": {
          id: "vendor-xyz/my-combo",
          name: "My Combo",
          description: "A fine model",
        },
      }),
    });

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("my-combo");
    expect(result[0].owned_by).toBe("combo");
    expect(result[0].models_dev_id).toBe("vendor-xyz/my-combo");
    expect(result[0].name).toBe("My Combo");
    expect(result[0].description).toBe("A fine model");
    expect(result[0].display_name).toBeUndefined();
  });

  it("does not enrich when bare name matches multiple entries (ambiguous)", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: true });
    getCombos.mockResolvedValue([
      { name: "ambiguous-combo", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([]);
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        "vendor-a/ambiguous-combo": { id: "vendor-a/ambiguous-combo" },
        "vendor-b/ambiguous-combo": { id: "vendor-b/ambiguous-combo" },
      }),
    });

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "ambiguous-combo",
      object: "model",
      owned_by: "combo",
    });
    expect(result[0].models_dev_id).toBeUndefined();
  });

  it("retains base Combo entry when fetch fails (fail-open)", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: true });
    getCombos.mockResolvedValue([
      { name: "failover-combo", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([]);
    global.fetch.mockRejectedValue(new Error("Network error"));

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "failover-combo",
      object: "model",
      owned_by: "combo",
    });
    expect(result[0].models_dev_id).toBeUndefined();
  });

  it("retains base Combo entry when fetch response is not ok", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: true });
    getCombos.mockResolvedValue([
      { name: "error-combo", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([]);
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "error-combo",
      object: "model",
      owned_by: "combo",
    });
    expect(result[0].models_dev_id).toBeUndefined();
  });

  it("does not fetch models.dev when infoFromModelsDev is false", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: false });
    getCombos.mockResolvedValue([
      { name: "no-fetch-combo", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([]);

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "no-fetch-combo",
      object: "model",
      owned_by: "combo",
    });
    expect(result[0].models_dev_id).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not overwrite combo id object owned_by even when models_dev_id differs", async () => {
    getSettings.mockResolvedValue({ exposeComboOnly: true, infoFromModelsDev: true });
    getCombos.mockResolvedValue([
      { name: "my-combo-v2", kind: "llm", models: ["gpt-4"] },
    ]);
    getProviderConnections.mockResolvedValue([]);
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        "different-vendor/my-combo-v2": {
          id: "different-vendor/my-combo-v2",
          name: "Different Name",
          description: "Different description",
        },
      }),
    });

    const result = await buildModelsList(["llm"]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("my-combo-v2");
    expect(result[0].object).toBe("model");
    expect(result[0].owned_by).toBe("combo");
    expect(result[0].models_dev_id).toBe("different-vendor/my-combo-v2");
  });
});
