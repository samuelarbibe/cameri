import { ActivityIcon } from "lucide-react";
import { Link } from "react-router";
import { ModeToggle } from "@/components/mode-toggle";

/**
 * The shell's top bar, minus the sidebar toggle and breadcrumb, for pages with
 * no project for either to point at. The logo matches the sidebar's.
 */
export function TopBar() {
  return (
    <header className="bg-background sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <Link to="/" className="flex items-center gap-2">
        <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
          <ActivityIcon className="size-4" />
        </div>
        <div className="flex flex-col gap-0.5 leading-none">
          <span className="text-sm font-medium">cameri</span>
          <span className="text-muted-foreground text-xs">Playwright reporting</span>
        </div>
      </Link>
      <div className="ml-auto">
        <ModeToggle />
      </div>
    </header>
  );
}
