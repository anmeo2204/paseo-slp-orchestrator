import { describe, expect, it } from "vitest";
import { isProviderQuotaError } from "../server/pipeline/provider-quota";

describe("isProviderQuotaError", () => {
  it("matches provider messages that mean tokens or credits are exhausted", () => {
    expect(isProviderQuotaError("Your credit balance is too low to access the Anthropic API")).toBe(true);
    expect(isProviderQuotaError(new Error("You exceeded your current quota, please check your plan and billing details"))).toBe(true);
    expect(isProviderQuotaError("insufficient_quota")).toBe(true);
    expect(isProviderQuotaError("out of credits")).toBe(true);
    expect(isProviderQuotaError("You've hit your usage limit")).toBe(true);
  });

  it("leaves rate limits and context-window errors to the normal retry path", () => {
    expect(isProviderQuotaError("429 Too Many Requests")).toBe(false);
    expect(isProviderQuotaError("Rate limit reached for requests")).toBe(false);
    expect(isProviderQuotaError("This model's maximum context length is 128000 tokens")).toBe(false);
    expect(isProviderQuotaError("The model returned an empty response")).toBe(false);
  });
});
