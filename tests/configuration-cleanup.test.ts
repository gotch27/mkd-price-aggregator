import { expect, it } from "vitest";
import { configSchema, settings } from "@/nextsignal/config";

it("rejects retired AI and matching switches instead of accepting inactive controls", () => {
  for (const obsolete of [
    { ai: { enabled: true } },
    { enabled: true },
    { automatic_enabled: true },
    { retry_hours: 168 },
    { ambiguity_batch_size: 10000 },
  ]) {
    expect(
      configSchema.safeParse({
        ...settings,
        matching: { ...settings.matching, ...obsolete },
      }).success,
    ).toBe(false);
  }
});

it("rejects the retired per-retailer scheduling configuration", () => {
  expect(
    configSchema.safeParse({
      ...settings,
      scheduler: { ...settings.scheduler, cron: "0 12 * * 1" },
    }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({
      ...settings,
      sources: {
        ...settings.sources,
        kam: { ...settings.sources.kam, cron: "0 12 * * 1" },
      },
    }).success,
  ).toBe(false);
});

it("keeps reviewed language dictionaries out of operational configuration", () => {
  for (const obsolete of [{ brands: [] }, { token_aliases: {} }, { ignored_tokens: [] }]) {
    expect(configSchema.safeParse({ ...settings, matching: { ...settings.matching, local: { ...settings.matching.local, ...obsolete } } }).success).toBe(false);
  }
});
