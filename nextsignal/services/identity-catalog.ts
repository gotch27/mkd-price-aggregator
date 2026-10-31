import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { settings } from "@/nextsignal/config";
import { identityCatalogSchema } from "@/nextsignal/domain/matching-identity";
const root = resolve(settings.matching.prompts.root),
  path = resolve(root, settings.matching.identity.profiles_file);
if (
  isAbsolute(settings.matching.identity.profiles_file) ||
  relative(root, path).startsWith("..")
)
  throw new Error(
    "Identity profile file must stay inside the prompt directory",
  );
export const identityCatalog = identityCatalogSchema.parse(
  JSON.parse(readFileSync(path, "utf8")),
);
