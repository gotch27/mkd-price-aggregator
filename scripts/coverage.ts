import { mkdir, writeFile } from "node:fs/promises";
import { settings } from "@/nextsignal/config";
import { dashboardSummary } from "@/nextsignal/services/catalog-repository";
import { pool } from "@/nextsignal/services/database";
try {
  const retailers = await dashboardSummary();
  const sources = (
    await pool.query(
      `SELECT s.*,r.status AS latest_status,r.error AS latest_error,r.id AS latest_run_id FROM sources s LEFT JOIN LATERAL(SELECT id,status,error FROM runs WHERE source_id=s.id AND kind='catalog' ORDER BY created_at DESC LIMIT 1) r ON true WHERE s.active ORDER BY s.retailer,s.name`,
    )
  ).rows;
  const now = new Date();
  const scopes = sources.map((s) => ({
    ...s,
    age_hours: s.last_success
      ? (now.getTime() - new Date(s.last_success).getTime()) / 3600000
      : null,
    fresh:
      s.last_success !== null &&
      now.getTime() - new Date(s.last_success).getTime() <=
        settings.ingestion.freshness_hours * 3600000,
    timestamp_policy: settings.sources[s.retailer].timestamp_policy,
    notice: settings.sources[s.retailer].notice,
  }));
  const gaps = scopes.filter(
    (s) =>
      !s.fresh ||
      s.meta.unavailable === true ||
      !["success", "superseded"].includes(s.latest_status),
  );
  const shared = scopes.filter((s) => s.scope !== "branch");
  const empty = scopes.filter((s) => s.last_success && s.row_count === 0);
  const report = {
    generated_at: now.toISOString(),
    catalog_import_complete: gaps.length === 0 && scopes.length > 0,
    verified_branch_coverage_complete:
      gaps.length === 0 && shared.length === 0 && scopes.length > 0,
    current_offers: retailers.reduce((sum, r) => sum + Number(r.offers), 0),
    freshness_hours: settings.ingestion.freshness_hours,
    retailers,
    gaps,
    shared_catalogs: shared,
    confirmed_empty_catalogs: empty,
    sources: scopes,
  };
  await mkdir(".data", { recursive: true });
  await writeFile(".data/coverage.json", JSON.stringify(report, null, 2));
  const lines = [
    `# Catalog coverage — ${report.generated_at}`,
    "",
    `Catalog import complete: **${report.catalog_import_complete}**. Verified branch coverage complete: **${report.verified_branch_coverage_complete}**.`,
    `Current offers: ${report.current_offers.toLocaleString()}. Freshness limit: ${report.freshness_hours} hours.`,
    "",
    "| Retailer | Imported / discovered | Offers | Last success |",
    "| --- | ---: | ---: | --- |",
    ...retailers.map(
      (r) =>
        `| ${r.name} | ${r.imported} / ${r.sources} | ${Number(r.offers).toLocaleString()} | ${r.last_success ?? "Never"} |`,
    ),
    "",
    "## Shared catalogs",
    ...shared.map((s) => `- ${s.name}: ${s.notice}; ${JSON.stringify(s.meta)}`),
    "",
    "## Confirmed empty catalogs",
    ...empty.map((s) => `- ${s.retailer}: ${s.name} (${s.url})`),
    "",
    `## Import gaps (${gaps.length})`,
    ...gaps.map(
      (s) =>
        `- ${s.retailer}: ${s.name} — ${s.latest_status ?? "No run"}; ${s.latest_error ?? (s.fresh ? "Latest retrieval incomplete" : "No fresh publication")}`,
    ),
    "",
    "The JSON report contains original source URLs, branch metadata, run IDs, timestamps and scope for every discovered catalog.",
  ];
  await writeFile(".data/coverage.md", lines.join("\n") + "\n");
  console.table(
    retailers.map((r) => ({
      retailer: r.name,
      imported: `${r.imported}/${r.sources}`,
      offers: r.offers,
      last_success: r.last_success,
    })),
  );
  console.info({
    catalog_import_complete: report.catalog_import_complete,
    verified_branch_coverage_complete: report.verified_branch_coverage_complete,
    gaps: gaps.length,
    shared_catalogs: shared.length,
    confirmed_empty_catalogs: empty.length,
    report: ".data/coverage.md",
  });
} finally {
  await pool.end();
}
