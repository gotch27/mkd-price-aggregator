import { TableCell } from "@/components/ui/table";
import { StoreLogo } from "@/app/_components/dashboard/store-logo";
import { Status } from "@/app/_components/dashboard/status";
import {
  priceRange,
  text,
  number,
  storeName,
  kindName,
  type DateFormatter,
  type Row,
  type TableView,
} from "@/app/_components/dashboard/types";
export function RecordCells({
  view,
  row,
  date,
}: {
  view: TableView;
  row: Row;
  date: DateFormatter;
}) {
  switch (view) {
    case "products":
      return (
        <>
          <TableCell>
            <div className="cell-title">{text(row.name)}</div>
            <div className="cell-note">
              {text(row.category, "Uncategorized")}
            </div>
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <StoreLogo slug={text(row.retailer)} />
              <div>
                {storeName(row.retailer)}
                <div className="cell-note">
                  {row.catalog_name
                    ? "This catalog"
                    : `${number(row.catalog_count)} catalogs`}
                </div>
              </div>
            </div>
          </TableCell>
          <TableCell>
            <span className="price-value">{priceRange(row)}</span>
          </TableCell>
          <TableCell>
            <Status
              value={
                Number(row.connected_retailers) > 1 ? "matched" : "separate"
              }
            />
            <div className="cell-note">
              {number(row.connected_retailers)}{" "}
              {Number(row.connected_retailers) === 1 ? "store" : "stores"}
            </div>
          </TableCell>
        </>
      );
    case "universal":
      return (
        <>
          <TableCell>
            <div className="cell-title">{text(row.name)}</div>
            <div className="cell-note">
              {number(row.listing_count)} connected store products
            </div>
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-1">
              {(row.retailers as string[]).map((s) => (
                <span title={storeName(s)} key={s}>
                  <StoreLogo slug={s} />
                </span>
              ))}
            </div>
          </TableCell>
          <TableCell>
            <span className="price-value">{priceRange(row)}</span>
          </TableCell>
          <TableCell>
            <Status
              value={
                Number(row.connected_retailers) > 1 ? "matched" : "separate"
              }
            />
          </TableCell>
        </>
      );
    case "sources":
      return (
        <>
          <TableCell>
            <div className="cell-title">{text(row.name)}</div>
            <div className="cell-note">
              {row.scope === "branch"
                ? "Branch catalog"
                : "Shared online catalog"}
            </div>
          </TableCell>
          <TableCell>{number(row.row_count)}</TableCell>
          <TableCell>
            <Status
              value={
                Boolean(row.latest_status) && row.latest_status !== "success"
                  ? row.latest_status
                  : row.last_success
                    ? row.fresh
                      ? "fresh"
                      : "stale"
                    : "pending"
              }
            />
          </TableCell>
          <TableCell>
            <span className="cell-date">{date(row.last_success)}</span>
          </TableCell>
        </>
      );
    case "runs":
      return (
        <>
          <TableCell>
            <div className="cell-title">{kindName(row.kind)}</div>
            <div className="cell-note">
              {text(
                row.source_name,
                row.kind === "match"
                  ? "Connect equivalent products"
                  : "Discover published catalogs",
              )}
            </div>
          </TableCell>
          <TableCell>
            {row.retailer ? (
              <div className="flex items-center gap-2">
                <StoreLogo slug={text(row.retailer)} />
                {storeName(row.retailer)}
              </div>
            ) : (
              "All stores"
            )}
          </TableCell>
          <TableCell>
            <Status value={row.status} />
          </TableCell>
          <TableCell>
            <span className="cell-date">{date(row.created_at)}</span>
          </TableCell>
          <TableCell>{number(row.attempts)}</TableCell>
        </>
      );
    case "logs":
      return (
        <>
          <TableCell>
            <Status value={row.level} />
          </TableCell>
          <TableCell>
            <div className="cell-title log-message">{text(row.message)}</div>
            {Boolean(row.retailer) && (
              <div className="cell-note">{storeName(row.retailer)}</div>
            )}
          </TableCell>
          <TableCell>
            <span className="cell-note">{text(row.process)}</span>
          </TableCell>
          <TableCell>
            <span className="cell-date">{date(row.created_at)}</span>
          </TableCell>
        </>
      );
    case "decisions":
      return null;
  }
}
