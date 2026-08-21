import type * as React from "react";
import { Fragment } from "react";
import { Link } from "react-router";
import { AppSidebar, type SidebarProject } from "@/components/app-sidebar";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

/** A crumb without an `href` is the current page. */
export type Crumb = { label: string; href?: string };

type AppShellProps = {
  projects: SidebarProject[];
  activeSlug: string;
  onSelectProject: (slug: string) => void;
  projectsLoading?: boolean;
  trail: Crumb[];
  children: React.ReactNode;
};

/**
 * The `sidebar-04` page layout: floating sidebar, inset content, sticky header
 * with the trigger and a breadcrumb. The only additions are the theme toggle and
 * the toaster, both of which live at this level because they are app-wide.
 */
export function AppShell({
  projects,
  activeSlug,
  onSelectProject,
  projectsLoading,
  trail,
  children,
}: AppShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar
        projects={projects}
        activeSlug={activeSlug}
        onSelectProject={onSelectProject}
        isLoading={projectsLoading}
      />
      <SidebarInset>
        <header className="bg-background sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              {trail.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  {index > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {crumb.href ? (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage className="max-w-[40ch] truncate">
                        {crumb.label}
                      </BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto">
            <ModeToggle />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
}
