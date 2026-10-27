import { cookies } from "next/headers";
import { settings } from "@/nextsignal/config";
import { validSession, SESSION_COOKIE } from "@/nextsignal/adapters/auth";
import Dashboard from "./dashboard";
export const dynamic = "force-dynamic";
export default async function Page() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return (
    <Dashboard
      authenticated={!!token && validSession(token)}
      pageSize={settings.dashboard.page_size}
      timezone={settings.app.timezone}
      refreshMs={settings.dashboard.refresh_ms}
      debounceMs={settings.dashboard.search_debounce_ms}
      autoRefreshViews={settings.dashboard.auto_refresh_views}
      initialNameQuality={settings.dashboard.product_name_quality}
      initialAvailability={settings.dashboard.product_availability}
    />
  );
}
