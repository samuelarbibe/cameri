import { ActivityIcon } from "lucide-react";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

/** Only what the sidebar needs, so it isn't coupled to the full project row. */
export type SidebarProject = { slug: string; name: string };

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  projects: SidebarProject[];
  activeSlug: string;
  onSelectProject: (slug: string) => void;
  isLoading?: boolean;
};

/**
 * The `sidebar-04` block, with its docs-nav sample data replaced by the real
 * project list. The block's two-level shape maps onto the data as-is: a section
 * heading per area, projects as the sub-items under it.
 */
export function AppSidebar({
  projects,
  activeSlug,
  onSelectProject,
  isLoading = false,
  ...props
}: AppSidebarProps) {
  return (
    <Sidebar variant="floating" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <ActivityIcon className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-medium">cameri</span>
                  <span className="text-xs">Playwright reporting</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className="gap-2">
            <SidebarMenuItem>
              {/* A heading, not a target — rendered as a span so it neither
                  takes focus nor lights up on hover. */}
              <SidebarMenuButton asChild className="font-medium hover:bg-transparent">
                <span>Projects</span>
              </SidebarMenuButton>
              <SidebarMenuSub className="ml-0 border-l-0 px-1.5">
                {isLoading ? (
                  <SidebarMenuSubItem>
                    <Skeleton className="h-7 w-full" />
                  </SidebarMenuSubItem>
                ) : projects.length === 0 ? (
                  <SidebarMenuSubItem>
                    <span className="text-muted-foreground px-2 text-xs">No projects yet</span>
                  </SidebarMenuSubItem>
                ) : (
                  projects.map((project) => (
                    <SidebarMenuSubItem key={project.slug}>
                      {/* `asChild` so this is a real button: the default <a>
                          has no href here and would drop out of the tab order. */}
                      <SidebarMenuSubButton asChild isActive={project.slug === activeSlug}>
                        <button
                          type="button"
                          className="w-full cursor-pointer"
                          onClick={() => onSelectProject(project.slug)}
                        >
                          <span>{project.name}</span>
                        </button>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))
                )}
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
