import { createNextRoute } from "@gotch/nextsignal/next";
import { app } from "@/nextsignal/app";
export const runtime = "nodejs";
export const PATCH = createNextRoute(app, "brands.edit");
