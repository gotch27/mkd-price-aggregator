import { afterEach, expect, it, vi } from "vitest";
import { createReadCache } from "@/nextsignal/services/read-cache";

afterEach(() => vi.useRealTimers());

it("shares a slow in-flight read and starts freshness after completion", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const cached = createReadCache(1000, read);
  const first = cached();
  await Promise.resolve();
  vi.advanceTimersByTime(5000);
  const second = cached();
  expect(second).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  finish("saved result");
  await expect(first).resolves.toBe("saved result");
  vi.advanceTimersByTime(999);
  await expect(cached()).resolves.toBe("saved result");
  expect(read).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  const next = cached();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  finish("fresh result");
  await expect(next).resolves.toBe("fresh result");
});

it("releases a failed request so the next caller can retry", async () => {
  const read = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValueOnce("recovered");
  const cached = createReadCache(1000, read);
  await expect(cached()).rejects.toThrow("database unavailable");
  await expect(cached()).resolves.toBe("recovered");
  expect(read).toHaveBeenCalledTimes(2);
});
