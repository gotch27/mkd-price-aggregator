import { LogOut } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { views, type Screen } from "@/app/_components/dashboard/types";
export function Navigation({
  screen,
  onNavigate,
  onLogout,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
  onLogout: () => void;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar>
      <SidebarContent className="pt-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {(Object.keys(views) as Screen[]).map((key) => {
                const v = views[key];
                return (
                  <SidebarMenuItem key={key}>
                    <SidebarMenuButton
                      isActive={screen === key}
                      onClick={() => {
                        onNavigate(key);
                        setOpenMobile(false);
                      }}
                    >
                      <v.icon />
                      <span>{v.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onLogout}>
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
