/** Convert a retailer wall-clock timestamp using the configured IANA timezone. */
export function sourceTimestamp(text: string, timezone: string): string | null {
  const readable = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const label = readable.match(
    /(?:последно(?:то)?\s+ажурирање|датум и време[^:]{0,120}):?\s*(.{0,100})/i,
  );
  if (label) text = label[1];
  const iso = text.match(
    /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  const local = text.match(
    /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i,
  );
  if (!iso && !local) return null;
  const parts = iso
    ? [
        Number(iso[1]),
        Number(iso[2]),
        Number(iso[3]),
        Number(iso[4]),
        Number(iso[5]),
        Number(iso[6] ?? 0),
      ]
    : [
        Number(local![3]),
        Number(local![2]),
        Number(local![1]),
        Number(local![4]),
        Number(local![5]),
        Number(local![6] ?? 0),
      ];
  if (!iso && local?.[7])
    parts[3] = (parts[3] % 12) + (local[7].toUpperCase() === "PM" ? 12 : 0);
  const wall = Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5],
  );
  let guess = wall;
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      format.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    guess =
      wall -
      (Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second),
      ) -
        guess);
  }
  return Number.isFinite(guess) ? new Date(guess).toISOString() : null;
}
