import { createNextRoute } from "@gotch/nextsignal/next";
import { app } from "@/nextsignal/app";
export const runtime = "nodejs";
export const GET = createNextRoute(app, "tasks.settingsRead");
export const PATCH = createNextRoute(app, "tasks.settingsSave");
