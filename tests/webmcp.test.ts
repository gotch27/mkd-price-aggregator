import { expect, it, vi } from "vitest";
import {
  pageModelContext,
  registerPageTools,
  type PageTool,
} from "@/lib/webmcp";
const tool: PageTool = {
  name: "read",
  description: "Read a queue",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  execute: async () => "{}",
};
it("uses the standard Document API first and supports the older Navigator API", () => {
  const modern = { registerTool: vi.fn() },
    legacy = { registerTool: vi.fn() };
  expect(
    pageModelContext({ modelContext: modern }, { modelContext: legacy }),
  ).toBe(modern);
  expect(pageModelContext({}, { modelContext: legacy })).toBe(legacy);
});
it("leaves unsupported browsers alone and never registers on an aborted page", async () => {
  const abort = new AbortController();
  expect(await registerPageTools([tool], {}, {}, abort.signal)).toBe(false);
  abort.abort();
  const registerTool = vi.fn();
  expect(
    await registerPageTools(
      [tool],
      { modelContext: { registerTool } },
      {},
      abort.signal,
    ),
  ).toBe(false);
  expect(registerTool).not.toHaveBeenCalled();
});
it("cleans up only its own legacy tools on navigation or logout", async () => {
  const abort = new AbortController(),
    registerTool = vi.fn(),
    unregisterTool = vi.fn();
  expect(
    await registerPageTools(
      [tool],
      {},
      { modelContext: { registerTool, unregisterTool } },
      abort.signal,
    ),
  ).toBe(true);
  abort.abort();
  expect(unregisterTool).toHaveBeenCalledExactlyOnceWith("read");
});
it("uses an abort signal for modern cleanup and removes partial registrations on failure", async () => {
  const abort = new AbortController();
  let registrationSignal: AbortSignal | undefined;
  const registerTool = vi.fn(
    async (_t, _o: { signal: AbortSignal } | undefined) => {
      registrationSignal = _o?.signal;
      if (registerTool.mock.calls.length === 2)
        throw new Error("Registration failed");
    },
  );
  await expect(
    registerPageTools(
      [tool, { ...tool, name: "other" }],
      { modelContext: { registerTool } },
      {},
      abort.signal,
    ),
  ).rejects.toThrow("Registration failed");
  expect(registrationSignal?.aborted).toBe(true);
});
