import { expect, it, vi } from "vitest";
import { brandReviewTools } from "@/lib/brand-review-tools";
import type { BrandReviewContext } from "@/nextsignal/domain/brand-review";
const context: BrandReviewContext = {
  limits: {
    default_groups: 50,
    default_include_previously_skipped: false,
    max_groups: 1000,
    batch_size: 10,
    examples_per_group: 6,
    scan_products: 5000,
    refresh_ms: 5000,
    results_page_size: 10,
  },
  instructions: "Source-backed aliases only",
  session: null,
  refresh_pending: 0,
};
it("registers bounded brand tools independently of category review and fixes Agent provenance", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true }),
    scope = { retailer: "spar", search: "yogurt" };
  const tools = brandReviewTools(
    context,
    ["kam", "spar"],
    () => scope,
    request,
  );
  expect(new Set(tools.map((t) => t.name)).size).toBe(8);
  const start = tools.find((t) => t.name === "start_brand_review")!;
  await start.execute({ request_id: "stable-request", limit: 10 });
  expect(request).toHaveBeenLastCalledWith(
    "/api/review/brand-sessions",
    expect.objectContaining({
      request_id: "stable-request",
      reviewer: "agent",
      retailer: "spar",
      search: "yogurt",
      limit: 10,
      include_previously_skipped: false,
    }),
    undefined,
  );
  const submit = tools.find((t) => t.name === "submit_brand_review_batch")!;
  await submit.execute({
    session_id: "session",
    request_id: "request",
    decisions: [],
  });
  expect(request).toHaveBeenLastCalledWith(
    "/api/review/brand-sessions/session/decisions",
    { request_id: "request", reviewer: "agent", decisions: [] },
    undefined,
  );
  expect(submit.annotations.readOnlyHint).toBe(false);
  expect(
    tools
      .filter((t) => t.name.startsWith("get_") || t.name === "search_brands")
      .every((t) => t.annotations.readOnlyHint),
  ).toBe(true);
});
