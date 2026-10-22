import { Link2, ShieldCheck, History, CircleHelp } from "lucide-react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  text,
  storeName,
  label,
  type Row,
  type DateFormatter,
} from "@/app/_components/dashboard/types";
const methods: Record<string, { title: string; description: string }> = {
  gtin: {
    title: "Same barcode",
    description:
      "The products share a validated barcode and have compatible attributes.",
  },
  "local-rules": {
    title: "Product attributes match",
    description:
      "Local rules found matching product identity, size, pack, and variant information.",
  },
  fingerprint: {
    title: "Same name and attributes",
    description: "The normalized names and complete product attributes agree.",
  },
  decisions: {
    title: "AI comparison",
    description:
      "The matching service compared the product descriptions and attributes.",
  },
  separate: {
    title: "Kept separate",
    description:
      "There was not enough evidence to connect this listing to another product.",
  },
  ambiguous: {
    title: "Source identity is unclear",
    description:
      "The source identifies this product ambiguously. It remains separate to avoid an incorrect match.",
  },
};
export function MatchingHistory({
  decisions,
  date,
}: {
  decisions: Row[];
  date: DateFormatter;
}) {
  if (!decisions.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleHelp />
          </EmptyMedia>
          <EmptyTitle>No matching history yet</EmptyTitle>
          <EmptyDescription>
            When matching runs, its decisions and explanations will appear here.
            No connection is assumed without supporting evidence.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Why these products match, or why they were kept separate. Newest
        decisions appear first.
      </p>
      <Accordion type="multiple">
        {decisions.map((d) => {
          const method = methods[text(d.method)] ?? {
            title: label(text(d.method)),
            description: "A decision recorded by the product matching service.",
          };
          const evidence = (
            Array.isArray(d.candidates) ? d.candidates : []
          ) as Row[];
          return (
            <AccordionItem value={text(d.id)} key={text(d.id)}>
              <AccordionTrigger>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="match-history-icon">
                    {d.product_id ? <ShieldCheck /> : <History />}
                  </span>
                  <div className="flex min-w-0 flex-col gap-1 text-left">
                    <span>{method.title}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {storeName(d.retailer)} · {date(d.created_at)}
                    </span>
                    {d.current_identity === false && (
                      <Badge variant="outline">Previous product version</Badge>
                    )}
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="flex flex-col gap-4">
                  <p>{method.description}</p>
                  <dl className="detail-fields">
                    <div>
                      <dt>Store product</dt>
                      <dd>{text(d.name)}</dd>
                    </div>
                    <div>
                      <dt>Result</dt>
                      <dd>
                        {d.product_id
                          ? "Connected to a universal product"
                          : "No confirmed connection"}
                      </dd>
                    </div>
                    {d.probability !== null && d.probability !== undefined && (
                      <div>
                        <dt>Recorded confidence</dt>
                        <dd>{(Number(d.probability) * 100).toFixed(1)}%</dd>
                      </div>
                    )}
                    {Boolean(d.model) && (
                      <div>
                        <dt>Model</dt>
                        <dd>{text(d.model)}</dd>
                      </div>
                    )}
                  </dl>
                  {evidence.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <h4 className="font-medium">Compared products</h4>
                      {evidence.map((e, i) => (
                        <div key={i} className="evidence-item">
                          <Link2 className="size-4 shrink-0 text-muted-foreground" />
                          <div>
                            <p>
                              {text(
                                e.candidate_name,
                                "Previously compared product",
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {e.candidate_retailer
                                ? `${storeName(e.candidate_retailer)} · `
                                : ""}
                              {methods[text(e.method)]?.title ??
                                (e.method
                                  ? label(text(e.method))
                                  : "No conclusive match")}
                              {e.probability !== null &&
                              e.probability !== undefined
                                ? ` · ${(Number(e.probability) * 100).toFixed(1)}% confidence`
                                : ""}
                            </p>
                            {Boolean(e.reason) && <p>{text(e.reason)}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
      <p className="text-xs text-muted-foreground">
        Shows the most recent recorded decisions. Confidence describes the
        recorded comparison; it is not a guarantee of product equivalence.
      </p>
    </div>
  );
}
