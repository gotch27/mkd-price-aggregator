import { SourceError } from "@/nextsignal/domain/types";

// The published-price platform can return a plain-text upstream connection
// failure with HTTP 200. Recognize that response before recording HTTP success
// or handing it to a catalog parser. Never inspect arbitrary product text.
export function sourceResponseError(bytes: Buffer): SourceError | null {
  const marker = "Error fetching ";
  const offset =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (
    bytes.toString("utf8", offset, offset + marker.length).toLowerCase() !==
    marker.toLowerCase()
  )
    return null;
  const match = bytes
    .toString("utf8", offset)
    .trim()
    .match(/^Error fetching (organizations|products|articles):\s*(.+)$/is);
  if (!match) return null;
  const detail = match[2];
  const reason = /timed?\s*out|timeout/i.test(detail)
    ? "connection_timeout"
    : /connection refused|couldn['’]?t connect|failed to connect/i.test(detail)
      ? "connection_failed"
      : /could not resolve host|couldn['’]?t resolve host/i.test(detail)
        ? "name_resolution_failed"
        : /connection reset|empty reply from server/i.test(detail)
          ? "connection_interrupted"
          : null;
  if (!reason) return null;
  const operation = match[1].toLowerCase();
  const label = operation === "organizations" ? "store list" : "product list";
  const error = new SourceError(
    `The store's price website could not load its ${label}: ${
      reason === "connection_timeout"
        ? "its internal server connection timed out"
        : "its internal server connection failed"
    }. This is a temporary problem on the price website.`,
    true,
  );
  // Keep provider payloads, internal addresses and potential credentials out of
  // application logs. The operation and failure kind are enough to diagnose it.
  error.diagnostics = {
    phase: "provider_response",
    provider_operation: operation,
    provider_failure: reason,
  };
  return error;
}
