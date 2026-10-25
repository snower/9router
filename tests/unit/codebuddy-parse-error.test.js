import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

describe("CodeBuddy parseError", () => {
  it("parses code 6004 frequency limit with timestamp into 429 and resetsAtMs on codebuddy-cn", () => {
    const executor = new CodeBuddyExecutor();
    const bodyText = JSON.stringify({
      code: 6004,
      message: "当前模型超出频率限制，请于 2026-09-28 14:30:00 后重试",
    });

    const parsed = executor.parseError({ status: 200 }, bodyText);
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("超出频率限制");
    expect(parsed.resetsAtMs).toBeTruthy();
    expect(typeof parsed.resetsAtMs).toBe("number");

    // 验证时区解析 (默认 UTC+8)
    const expected = new Date("2026-09-28T14:30:00+08:00").getTime();
    expect(parsed.resetsAtMs).toBe(expected);
  });

  it("parses frequency limit text match without code 6004 on codebuddy-intl", () => {
    const executor = new CodeBuddyIntlExecutor();
    const bodyText = JSON.stringify({
      code: 11000,
      msg: "frequency limit exceeded, please retry after 2026-09-28 12:00:00 UTC+0",
    });

    const parsed = executor.parseError({ status: 400 }, bodyText);
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("frequency limit");
    const expected = new Date("2026-09-28T12:00:00+00:00").getTime();
    expect(parsed.resetsAtMs).toBe(expected);
  });

  it("falls back to super.parseError for unrelated errors", () => {
    const executor = new CodeBuddyExecutor();
    const bodyText = JSON.stringify({
      code: 11101,
      message: "Non-stream chat request is currently not supported",
    });

    const parsed = executor.parseError({ status: 400 }, bodyText);
    expect(parsed.status).toBe(400);
    expect(parsed.message).toBe(bodyText);
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});

describe("CodeBuddy CN system prompt neutralization setting", () => {
  const LONG_PROMPT = `You are Claude Code, Anthropic's official CLI for Claude. ${"x".repeat(2100)}`;
  const SHORT_AGENT_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
  const USER_PROMPT = "Reply in French and keep every answer under 20 words.";
  // Mirrors the executor's neutral marker exactly; the original text must survive as a user turn.
  const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";

  const transform = (systemPrompt, flag) => {
    const executor = new CodeBuddyExecutor();
    const body = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "hello" },
      ],
    };
    const transformed = executor.transformRequest(
      "claude-sonnet-4.5",
      body,
      false,
      flag === undefined ? {} : { providerSystemPromptNeutralization: flag },
    );
    return transformed;
  };

  const transformMsgs = (messages, flag) => {
    const executor = new CodeBuddyExecutor();
    return executor.transformRequest(
      "claude-sonnet-4.5",
      { messages },
      false,
      flag === undefined ? {} : { providerSystemPromptNeutralization: flag },
    );
  };

  it("neutralizes long and agent-marker system prompts when the flag is absent (default enabled)", () => {
    for (const prompt of [LONG_PROMPT, SHORT_AGENT_PROMPT]) {
      const defaulted = transform(prompt);
      const explicitTrue = transform(prompt, true);

      expect(defaulted.messages).toHaveLength(3);
      expect(defaulted.messages[0]).toEqual({ role: "system", content: NEUTRAL_PROMPT });
      expect(defaulted.messages.filter((m) => m.role === "system" && m.content === NEUTRAL_PROMPT)).toHaveLength(1);
      expect(defaulted.messages[1]).toEqual({ role: "user", content: prompt });
      expect(defaulted.messages[2]).toEqual({ role: "user", content: "hello" });
      expect(defaulted.messages[1].content).toContain("Anthropic's official CLI");
      expect(explicitTrue.messages).toEqual(defaulted.messages);
    }
  });

  it("injects the neutral system once before the first match and preserves original order across mixed history", () => {
    const matchedSecond = `${SHORT_AGENT_PROMPT}`;
    const matchedFifth = `agent ${SHORT_AGENT_PROMPT}`;
    const messages = [
      { role: "user", content: "hi" },
      { role: "system", content: matchedSecond },
      { role: "assistant", content: "ok" },
      { role: "system", content: USER_PROMPT },
      { role: "system", content: matchedFifth },
    ];
    const t = transformMsgs(messages);
    expect(t.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "system", content: NEUTRAL_PROMPT },
      { role: "user", content: matchedSecond },
      { role: "assistant", content: "ok" },
      { role: "system", content: USER_PROMPT },
      { role: "user", content: matchedFifth },
    ]);
    expect(t.messages.filter((m) => m.role === "system" && m.content === NEUTRAL_PROMPT)).toHaveLength(1);
  });

  it("demotes typed-block system prompts while preserving the exact block objects", () => {
    const blocks = [{ type: "text", text: SHORT_AGENT_PROMPT }];
    const t = transformMsgs([{ role: "system", content: blocks }, { role: "user", content: "hi" }]);
    expect(t.messages[0]).toEqual({ role: "system", content: NEUTRAL_PROMPT });
    expect(t.messages[1].role).toBe("user");
    expect(t.messages[1].content).toBe(blocks);
    expect(t.messages[1].content).toEqual(blocks);
  });

  it("applies the >2000 length boundary exactly (2000 kept as system, 2001 demoted)", () => {
    const exact = "x".repeat(2000);
    const over = "x".repeat(2001);
    const kept = transformMsgs([{ role: "system", content: exact }]);
    expect(kept.messages).toHaveLength(1);
    expect(kept.messages[0]).toEqual({ role: "system", content: exact });

    const demoted = transformMsgs([{ role: "system", content: over }]);
    expect(demoted.messages).toHaveLength(2);
    expect(demoted.messages[0]).toEqual({ role: "system", content: NEUTRAL_PROMPT });
    expect(demoted.messages[1]).toEqual({ role: "user", content: over });
  });

  it("preserves message metadata when demoting a matched system prompt to user", () => {
    const sys = { role: "system", name: "agent-ctx", cache_control: { type: "ephemeral" }, content: SHORT_AGENT_PROMPT };
    const t = transformMsgs([sys]);
    expect(t.messages[0]).toEqual({ role: "system", content: NEUTRAL_PROMPT });
    expect(t.messages[1]).toEqual({ role: "user", name: "agent-ctx", cache_control: { type: "ephemeral" }, content: SHORT_AGENT_PROMPT });
    expect(t.messages[1]).not.toBe(sys);
  });

  it("preserves long and agent-marker system prompts untouched when the flag is false", () => {
    for (const prompt of [LONG_PROMPT, SHORT_AGENT_PROMPT]) {
      const transformed = transform(prompt, false);
      expect(transformed.messages[0]).toEqual({ role: "system", content: prompt });
    }
  });

  it("preserves typed-block system prompts when the flag is false", () => {
    const executor = new CodeBuddyExecutor();
    const blocks = [{ type: "text", text: SHORT_AGENT_PROMPT }];
    const transformed = executor.transformRequest(
      "claude-sonnet-4.5",
      { messages: [{ role: "system", content: blocks }, { role: "user", content: "hi" }] },
      false,
      { providerSystemPromptNeutralization: false },
    );
    expect(transformed.messages[0].content).toEqual(blocks);
  });

  it("leaves short legitimate user system prompts untouched either way", () => {
    expect(transform(USER_PROMPT).messages[0].content).toBe(USER_PROMPT);
    expect(transform(USER_PROMPT, false).messages[0].content).toBe(USER_PROMPT);
    // The user turn itself is never rewritten
    expect(transform(USER_PROMPT, false).messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("keeps forced streaming and reasoning mirroring unchanged when neutralization is disabled", () => {
    const executor = new CodeBuddyExecutor();
    const off = executor.transformRequest(
      "claude-sonnet-4.5",
      {
        stream: false,
        reasoning_effort: "high",
        messages: [{ role: "system", content: LONG_PROMPT }, { role: "user", content: "hi" }],
      },
      false,
      { providerSystemPromptNeutralization: false },
    );
    expect(off.stream).toBe(true);
    expect(off.reasoning_effort).toBe("high");
    expect(off.reasoning_summary).toBe("auto");

    const none = executor.transformRequest(
      "claude-sonnet-4.5",
      {
        reasoning_effort: "none",
        messages: [{ role: "system", content: LONG_PROMPT }, { role: "user", content: "hi" }],
      },
      false,
      { providerSystemPromptNeutralization: false },
    );
    expect(none.stream).toBe(true);
    expect(none.reasoning_effort).toBeUndefined();
    expect(none.reasoning_summary).toBeUndefined();
  });

  it("does not mutate the caller's message objects or leak state across requests", () => {
    const executor = new CodeBuddyExecutor();
    const sys = { role: "system", content: LONG_PROMPT };
    const body = { messages: [sys] };
    executor.transformRequest("m", body, false, { providerSystemPromptNeutralization: false });
    expect(sys).toEqual({ role: "system", content: LONG_PROMPT });
    expect(body.messages[0].content).toBe(LONG_PROMPT);

    // A disabled request must not switch neutralization off for the next one.
    executor.transformRequest("m", body, false, { providerSystemPromptNeutralization: false });
    const after = executor.transformRequest("m", body, false, {});
    expect(sys).toEqual({ role: "system", content: LONG_PROMPT });
    expect(after.messages[0]).toEqual({ role: "system", content: NEUTRAL_PROMPT });
    expect(after.messages[1]).toEqual({ role: "user", content: LONG_PROMPT });
    expect(after.messages[1]).not.toBe(sys);
  });
});
