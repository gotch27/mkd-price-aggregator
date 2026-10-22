import { load } from "cheerio";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settings } from "@/nextsignal/config";
import {
  SourceError,
  CatalogRestartRequired,
  type Retailer,
  type Source,
  type DiscoveredSource,
  type CatalogPage,
} from "@/nextsignal/domain/types";
import { fetchBytes, fetchJson, fetchText } from "./http";
import { sourceTimestamp } from "@/nextsignal/domain/source-time";
import {
  parseTable,
  parseSpar,
  selectedBranches,
  pagination,
  parseKam,
  parseWoo,
  publishedCounts,
} from "./parsers";
const exec = promisify(execFile);
function required(value: string | null, label: string): string {
  if (!value) throw new Error(`Required source configuration: ${label}`);
  return value;
}
export async function discover(
  retailer: Retailer,
): Promise<DiscoveredSource[]> {
  const config = settings.sources[retailer];
  const result: DiscoveredSource[] = [];
  const add = (
    external_id: string,
    name: string,
    url: string,
    scope: "branch" | "retailer",
    meta: Record<string, unknown>,
  ) => result.push({ retailer, external_id, name, url, scope, meta });
  if (retailer === "kam") {
    const shops = await fetchJson<
      {
        Id: number;
        Name: string;
        Address: string;
        ShopFiles: { RelativePath: string }[];
      }[]
    >(required(config.api_url, "kam.api_url"), { method: "POST" });
    for (const shop of shops) {
      const file = shop.ShopFiles[0];
      add(
        String(shop.Id),
        shop.Name,
        file ? new URL(file.RelativePath, config.url).href : config.url,
        "branch",
        { address: shop.Address, unavailable: !file },
      );
    }
  } else if (retailer === "reptil") {
    const body = await fetchJson<{
      acf: {
        locations: { title: string; address: string; pricelist: string }[];
      };
    }>(required(config.api_url, "reptil.api_url"));
    if (!Array.isArray(body.acf?.locations))
      throw new SourceError("Reptil location metadata changed", false);
    const groups = new Map<string, string[]>();
    for (const item of body.acf.locations) {
      if (!item.pricelist) continue;
      const list = groups.get(item.pricelist) ?? [];
      list.push(item.title);
      groups.set(item.pricelist, list);
    }
    for (const [url, branches] of groups)
      add(
        url,
        `Reptil shared online catalog (${branches.length} linked branches)`,
        url,
        "retailer",
        { branches, notice: config.notice },
      );
  } else {
    const html = await fetchText(config.url);
    const $ = load(html);
    if (["stokomak", "zito", "zur", "dim"].includes(retailer))
      for (const b of selectedBranches(html))
        add(b.id, b.name, config.url, "branch", {});
    else if (retailer === "spar")
      for (const a of $("a[href]").toArray()) {
        const href = $(a).attr("href")!,
          m = href.match(/^\/pricelist\/(\d+)$/);
        if (m)
          add(
            m[1],
            $(a).parent().text().replace(/\s+/g, " ").trim(),
            new URL(href, config.url).href,
            "branch",
            {},
          );
      }
    else if (retailer === "ramstore")
      for (const a of $("a[href]").toArray()) {
        const u = new URL($(a).attr("href")!, config.url);
        if (
          u.host === new URL(config.url).host &&
          /^\/marketi\/[^/]+\/$/.test(u.pathname)
        )
          add(
            u.pathname,
            $(a).closest("div").find("h2,h3").first().text().trim() ||
              u.pathname,
            u.href,
            "branch",
            {},
          );
      }
    if (retailer === "ramstore")
      for (const match of html.matchAll(
        /(?:href|location\.href)\s*=\s*['"]([^'"]*\/marketi\/[^'"]+)['"]/g,
      )) {
        const u = new URL(match[1], config.url);
        if (u.host === new URL(config.url).host)
          add(u.pathname, u.pathname, u.href, "branch", {});
      }
    if (retailer === "vero")
      for (const a of $("a[href]").toArray()) {
        const href = $(a).attr("href")!,
          m = href.match(/^(\d+)_1\.html$/);
        if (m && !/ЏАМБО|JUMBO/i.test($(a).text()))
          add(
            m[1],
            $(a).text().trim(),
            new URL(href, config.url).href,
            "branch",
            {},
          );
      }
  }
  const unique = [...new Map(result.map((s) => [s.external_id, s])).values()];
  if (!unique.length)
    throw new SourceError(
      `No published ${retailer} catalogs discovered`,
      false,
    );
  return unique;
}
export async function* retrieve(
  source: Source,
  cursor: string | null,
): AsyncGenerator<CatalogPage> {
  if (source.meta.unavailable)
    throw new SourceError("Branch has no published catalog", false);
  const cfg = settings.sources[source.retailer];
  let page = cursor ? Number(cursor) : 1;
  let updated: string | null = null;
  if (source.retailer === "spar") {
    const meta = await fetchJson<{ data: { updated_at: string | null } }>(
      new URL(source.external_id, required(cfg.api_url, "spar.api_url")).href,
    );
    if (meta.data?.updated_at) updated = meta.data.updated_at;
  }
  if (source.retailer === "zur" || source.retailer === "dim")
    updated = sourceTimestamp(await fetchText(cfg.url), settings.app.timezone);
  if (!Number.isInteger(page) || page < 1)
    throw new SourceError("Invalid persisted page cursor", false);
  if (source.retailer === "kam") {
    const { bytes } = await fetchBytes(source.url);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new SourceError("KAM source is not a PDF", false);
    const dir = await mkdtemp(join(tmpdir(), "mkd-catalog-"));
    try {
      await writeFile(join(dir, "catalog.pdf"), bytes);
      const { stdout: text } = await exec(
        "pdftotext",
        ["-layout", join(dir, "catalog.pdf"), "-"],
        {
          timeout: settings.http.timeout_ms,
          maxBuffer: settings.http.max_bytes,
        },
      );
      const sourceUpdatedAt = sourceTimestamp(text, settings.app.timezone);
      yield {
        rows: parseKam(text).map((r) => ({
          ...r,
          source_updated_at: sourceUpdatedAt,
        })),
        next: null,
        total: null,
        artifact: text,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }
  while (page <= settings.http.max_pages) {
    if (source.retailer === "reptil") {
      const url = new URL(
        required(cfg.catalog_api_url, "reptil.catalog_api_url"),
      );
      url.search = new URLSearchParams({
        page: String(page),
        per_page: String(cfg.page_size),
        orderby: "id",
        order: "asc",
      }).toString();
      const response = await fetchBytes(url.href);
      const body = JSON.parse(response.bytes.toString("utf8")) as Record<
        string,
        unknown
      >[];
      const total = Number(response.headers.get("x-wp-total")),
        last = Number(response.headers.get("x-wp-totalpages"));
      if (
        !Array.isArray(body) ||
        !response.headers.has("x-wp-total") ||
        !Number.isInteger(total) ||
        !Number.isInteger(last)
      )
        throw new SourceError(
          "Reptil public catalog pagination changed",
          false,
        );
      yield {
        rows: parseWoo(body),
        next: page < last ? String(page + 1) : null,
        total,
        artifact: null,
      };
      if (page >= last) return;
      page++;
      continue;
    }

    if (source.retailer === "spar") {
      const url = new URL(
        `${source.external_id}/products`,
        required(cfg.api_url, "spar.api_url"),
      );
      url.search = new URLSearchParams({
        page: String(page),
        per_page: String(cfg.page_size),
      }).toString();
      const body = await fetchJson<{
        success: boolean;
        data: Record<string, unknown>[];
        meta: { last_page: number; total: number; current_page: number };
      }>(url.href);
      if (
        !body.success ||
        !Array.isArray(body.data) ||
        !body.meta ||
        body.meta.current_page !== page ||
        !Number.isInteger(body.meta.last_page) ||
        !Number.isInteger(body.meta.total)
      )
        throw new SourceError("Invalid SPAR pagination", false);
      if (page >= body.meta.last_page) {
        const latest = await fetchJson<{ data: { updated_at: string | null } }>(
          new URL(source.external_id, required(cfg.api_url, "spar.api_url"))
            .href,
        );
        if ((latest.data?.updated_at ?? null) !== updated)
          throw new CatalogRestartRequired(
            "SPAR catalog changed during retrieval; start a fresh run",
          );
      }
      yield {
        rows: parseSpar(body.data).map((r) => ({
          ...r,
          source_updated_at: updated,
        })),
        next: page < body.meta.last_page ? String(page + 1) : null,
        total: body.meta.total,
        artifact: null,
      };
      if (page >= body.meta.last_page) return;
    } else if (source.retailer === "zur" || source.retailer === "dim") {
      const form = new URLSearchParams({
        action: required(cfg.action, "source.action"),
        org: source.external_id,
        page: String(page),
        search: "",
        limit: String(cfg.page_size),
      });
      const body = await fetchJson<{
        success: boolean;
        data: { html: string; total_pages: number };
      }>(required(cfg.api_url, "source.api_url"), {
        method: "POST",
        body: form,
      });
      if (
        !body.success ||
        typeof body.data?.html !== "string" ||
        !Number.isInteger(Number(body.data.total_pages))
      )
        throw new SourceError("Invalid AJAX catalog response", false);
      const last = Number(body.data.total_pages);
      yield {
        rows: parseTable(
          body.data.html,
          source.retailer,
          settings.ingestion.invalid_price_policy,
        ).map((r) => ({ ...r, source_updated_at: updated })),
        next: page < last ? String(page + 1) : null,
        total: null,
        artifact: null,
      };
      if (page >= last) return;
    } else {
      let url = new URL(source.url);
      if (source.retailer === "stokomak" || source.retailer === "zito")
        url.search = new URLSearchParams({
          org: source.external_id,
          page: String(page),
          perPage: String(cfg.page_size),
        }).toString();
      if (source.retailer === "vero")
        url = new URL(`${source.external_id}_${page}.html`, source.url);
      const html = await fetchText(url.href);
      if (source.retailer === "stokomak" || source.retailer === "zito") {
        const doc = load(html);
        const allowed = doc("select[name=perPage] option")
          .toArray()
          .map((o) => Number(doc(o).attr("value")));
        if (!allowed.includes(cfg.page_size))
          throw new SourceError(
            "Configured page size is unsupported by this retailer",
            false,
          );
      }
      const sourceUpdatedAt = sourceTimestamp(html, settings.app.timezone);
      const rows = parseTable(
        html,
        source.retailer,
        settings.ingestion.invalid_price_policy,
      ).map((r) => ({
        ...r,
        source_updated_at: sourceUpdatedAt,
      }));
      const links = pagination(html, url.href);
      const next = links.some((u) =>
        source.retailer === "vero"
          ? u.pathname.endsWith(`_${page + 1}.html`)
          : Number(u.searchParams.get("page")) === page + 1,
      );
      if (!rows.length && page > 1)
        throw new SourceError(
          `Catalog pagination returned an empty page ${page}`,
          false,
        );
      let total: number | null = null;
      if (source.retailer === "stokomak" || source.retailer === "zito") {
        const counts = publishedCounts(html);
        total = counts.total;
        if (
          (counts.total > 0 &&
            counts.from !== (page - 1) * cfg.page_size + 1) ||
          rows.length !==
            (counts.total === 0 ? 0 : counts.to - counts.from + 1) ||
          next !== counts.to < counts.total
        )
          throw new SourceError(
            "Published row counts disagree with parsed pagination",
            false,
          );
      }
      yield {
        rows,
        next: next ? String(page + 1) : null,
        total,
        artifact: page === 1 ? html : null,
      };
      if (!next) return;
    }
    page++;
  }
  throw new SourceError(
    "Configured maximum page count reached; catalog is incomplete",
    false,
  );
}
