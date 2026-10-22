import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { storeName } from "@/app/_components/dashboard/types";
import { cn } from "@/lib/utils";
const logos: Record<string, string> = {
  dim: "dim.png",
  kam: "kam.svg",
  ramstore: "ramstore.png",
  stokomak: "stokomak.png",
  spar: "spar.png",
  zito: "zito.png",
  vero: "vero.png",
  zur: "zur.jpeg",
  reptil: "reptil.png",
};
export function StoreLogo({
  slug,
  large = false,
}: {
  slug: string;
  large?: boolean;
}) {
  return (
    <Avatar
      data-brand={slug}
      className={cn("store-logo", large && "store-logo-large")}
    >
      {logos[slug] && (
        <AvatarImage
          src={`/stores/${logos[slug]}`}
          alt={`${storeName(slug)} logo`}
        />
      )}
      <AvatarFallback>
        {storeName(slug).slice(0, 3).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
