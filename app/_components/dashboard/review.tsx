"use client";
import { useState, type ComponentProps } from "react";
import { Tags, ListChecks } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CategoryReview } from "./category-review";
import { BrandReview } from "./brand-review";

export function Review(props: ComponentProps<typeof CategoryReview>) {
  const [section, setSection] = useState("categories");
  return (
    <Tabs value={section} onValueChange={setSection} className="gap-4">
      <TabsList aria-label="Review type">
        <TabsTrigger value="categories">
          <ListChecks /> Categories
        </TabsTrigger>
        <TabsTrigger value="brands">
          <Tags /> Brands
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="categories"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        <CategoryReview {...props} />
      </TabsContent>
      <TabsContent
        value="brands"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        <BrandReview
          onUnauthorized={props.onUnauthorized}
          onChanged={props.onChanged}
          onAgentActivity={() => setSection("brands")}
        />
      </TabsContent>
    </Tabs>
  );
}
