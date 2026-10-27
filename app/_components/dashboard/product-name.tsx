import { Badge } from "@/components/ui/badge";
import {
  readableProductText,
  productTextWarnings,
} from "@/nextsignal/domain/product-text";

export function ProductName({
  name,
  retailer,
  showSource = false,
}: {
  name: unknown;
  retailer: unknown;
  showSource?: boolean;
}) {
  const original = typeof name === "string" ? name : "—",
    store = typeof retailer === "string" ? retailer : "";
  const readable = readableProductText(original, store),
    warnings = productTextWarnings(original, store);
  return (
    <span className="flex flex-col gap-1">
      <span
        title={readable !== original ? `Store name: ${original}` : undefined}
      >
        {readable}
      </span>
      {showSource && readable !== original && (
        <span className="text-xs font-normal text-muted-foreground">
          Store name: {original}
        </span>
      )}
      {showSource && warnings.length > 0 && (
        <span>
          <Badge variant="outline" title={warnings.join(" ")}>
            Unclear source text
          </Badge>
        </span>
      )}
    </span>
  );
}
