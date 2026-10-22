import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const values = JSON.parse(await readFile("config/build.json", "utf8"));
const result = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  env: { ...process.env, ...values },
});
process.exit(result.status ?? 1);
