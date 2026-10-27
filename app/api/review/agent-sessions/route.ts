import { createNextRoute } from "@gotch/nextsignal/next";
import { app } from "@/nextsignal/app";
export const runtime = "nodejs";
export const GET = createNextRoute(app, "products.agentCategoryContext");
export const POST = createNextRoute(app, "products.startAgentCategoryReview");
