import { createNextRoute } from "@gotch/nextsignal/next";
import { app } from "@/nextsignal/app";
export const runtime = "nodejs";
export const GET = createNextRoute(app, "products.readCategory");
export const PATCH = createNextRoute(app, "products.saveCategory");
