import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export type FilterOption = { value: string; label: string; hint?: string };

/**
 * A search box and a row of single-choice dropdowns, all reading and writing
 * the URL.
 *
 * Built on `DropdownMenu` rather than a `<select>` so an option can carry a
 * second line — a branch name under a merge request title is the difference
 * between a usable menu and a list of numbers.
 */
export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  filters,
  onClear,
  children,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  filters: FilterSelectProps[];
  /** Shown only when something is actually filtered. */
  onClear?: (() => void) | undefined;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="h-8 pl-8"
        />
      </div>

      {filters.map((filter) => (
        <FilterSelect key={filter.label} {...filter} />
      ))}

      {onClear ? (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onClear}>
          <XIcon className="size-3.5" />
          Clear
        </Button>
      ) : null}

      {children}
    </div>
  );
}

export type FilterSelectProps = {
  label: string;
  value: string | null;
  options: FilterOption[];
  onChange: (value: string | null) => void;
  /** Copy for the "no filter" entry, e.g. "All branches". */
  anyLabel: string;
  emptyLabel?: string;
};

function FilterSelect({
  label,
  value,
  options,
  onChange,
  anyLabel,
  emptyLabel = "Nothing to filter by",
}: FilterSelectProps) {
  const selected = options.find((option) => option.value === value);
  // An unknown value still shows: the URL is the source of truth, and a filter
  // that is silently ignored because its option has aged out of the list would
  // show a full page while claiming to be filtered.
  const shown = selected?.label ?? value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={value === null ? "outline" : "secondary"}
          size="sm"
          className="h-8 max-w-56 px-2.5 text-xs"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="truncate">{shown ?? anyLabel}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-muted-foreground text-xs">{label}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="truncate">{anyLabel}</span>
          {value === null ? <CheckIcon className="ml-auto size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.length === 0 ? (
          <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>
        ) : (
          options.map((option) => (
            <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                {option.hint ? (
                  <span className="text-muted-foreground truncate text-xs">{option.hint}</span>
                ) : null}
              </span>
              {option.value === value ? <CheckIcon className="ml-auto size-4 shrink-0" /> : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
