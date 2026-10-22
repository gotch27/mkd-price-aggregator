import { randomBytes } from "node:crypto";
import { writeFile, readFile, access } from "node:fs/promises";
try {
  await access(".env.local");
  throw new Error(".env.local already exists; edit it explicitly.");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
let content = await readFile(".env.example", "utf8");
for (const [key, value] of Object.entries({
  __DATABASE_PASSWORD__: randomBytes(24).toString("hex"),
  __ADMIN_PASSWORD__: randomBytes(24).toString("base64url"),
  __SESSION_SECRET__: randomBytes(48).toString("hex"),
}))
  content = content.replaceAll(key, value);
await writeFile(".env.local", content, { mode: 0o600, flag: "wx" });
console.info(
  "Created .env.local from the explicit .env.example configuration. Review its values before starting.",
);
