import {
  ActivityIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FlaskConicalIcon,
  GitPullRequestArrowIcon,
  ListChecksIcon,
  SettingsIcon,
} from "lucide-react";
import type * as React from "react";
import { Link, useLocation } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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
 * Views down the side, project at the bottom.
 *
 * The project is not navigation — it is the scope everything else is read
 * through, and most people have one. Putting it in a switcher in the footer
 * frees the body of the sidebar for the thing that actually varies: which view
 * of that project you are looking at.
 */
const VIEWS = [
  { segment: "runs", label: "Test Runs", icon: ListChecksIcon },
  { segment: "mrs", label: "Merge Requests", icon: GitPullRequestArrowIcon },
  { segment: "tests", label: "Test Explorer", icon: FlaskConicalIcon },
  { segment: "settings", label: "Settings", icon: SettingsIcon },
] as const;

export function AppSidebar({
  projects,
  activeSlug,
  onSelectProject,
  isLoading = false,
  ...props
}: AppSidebarProps) {
  const { pathname } = useLocation();
  const active = VIEWS.find((view) => pathname.startsWith(`/${activeSlug}/${view.segment}`));

  return (
    <Sidebar variant="floating" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to={`/${activeSlug}/runs`}>
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <ActivityIcon className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-medium">cameri</span>
                  <span className="text-xs">Playwright reporting</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Views</SidebarGroupLabel>
          <SidebarMenu>
            {VIEWS.map((view) => (
              <SidebarMenuItem key={view.segment}>
                <SidebarMenuButton asChild isActive={view === active}>
                  <Link to={`/${activeSlug}/${view.segment}`}>
                    <view.icon />
                    <span>{view.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ProjectSwitcher
              projects={projects}
              activeSlug={activeSlug}
              onSelect={onSelectProject}
              isLoading={isLoading}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function ProjectSwitcher({
  projects,
  activeSlug,
  onSelect,
  isLoading,
}: {
  projects: SidebarProject[];
  activeSlug: string;
  onSelect: (slug: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) return <Skeleton className="h-12 w-full" />;

  const current = projects.find((project) => project.slug === activeSlug);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <div className="bg-sidebar-accent text-sidebar-accent-foreground flex aspect-square size-8 items-center justify-center rounded-md text-xs font-semibold uppercase">
            {(current?.name ?? activeSlug).slice(0, 2)}
          </div>
          <div className="grid flex-1 text-left leading-tight">
            <span className="text-muted-foreground text-xs">Project</span>
            <span className="truncate font-medium">{current?.name ?? activeSlug}</span>
          </div>
          <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      {/* Width matched to the trigger so the menu reads as an expansion of it
          rather than as a popup that happens to be nearby. */}
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={4}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs">Projects</DropdownMenuLabel>
        {projects.length === 0 ? (
          <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
        ) : (
          projects.map((project) => (
            <DropdownMenuItem key={project.slug} onSelect={() => onSelect(project.slug)}>
              <span className="truncate">{project.name}</span>
              {project.slug === activeSlug ? <CheckIcon className="ml-auto size-4" /> : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
