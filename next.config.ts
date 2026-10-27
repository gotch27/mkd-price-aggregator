import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: { "/*": ["./prompts/**/*"] },
  serverExternalPackages: ["pg", "pg-boss"],
};
export default config;
