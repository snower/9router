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

  it("neutralizes long and agent-marker system prompts when the flag is absent (default enabled)", () => {
    for (const prompt of [LONG_PROMPT, SHORT_AGENT_PROMPT]) {
      const defaulted = transform(prompt);
      const explicitTrue = transform(prompt, true);
      expect(defaulted.messages[0].content).not.toBe(prompt);
      expect(defaulted.messages[0].content).not.toContain("Anthropic's official CLI");
      expect(explicitTrue.messages[0].content).toBe(defaulted.messages[0].content);
    }
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

  it("does not mutate the caller's body or leak state across requests", () => {
    const executor = new CodeBuddyExecutor();
    const body = { messages: [{ role: "system", content: LONG_PROMPT }] };
    executor.transformRequest("m", body, false, { providerSystemPromptNeutralization: false });
    expect(body.messages[0].content).toBe(LONG_PROMPT);

    // A disabled request must not switch neutralization off for the next one.
    executor.transformRequest("m", body, false, { providerSystemPromptNeutralization: false });
    const after = executor.transformRequest("m", body, false, {});
    expect(after.messages[0].content).not.toBe(LONG_PROMPT);
  });
});
