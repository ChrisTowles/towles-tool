import { useSkeleton } from "@/lib/use-loading-phase";
import { cn } from "@/lib/utils";

/** "Loading…" copy that stays out of sight while the wait is short and keeps
 * its line reserved, so content arriving neither flashes the message nor shifts.
 * Mount it only while loading. */
export function DelayedLoading({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const show = useSkeleton(true);
  return (
    <p
      aria-busy
      className={cn(
        "min-h-5 text-sm text-muted-foreground",
        show && "motion-safe:animate-in motion-safe:fade-in-0 duration-200",
        !show && "invisible",
        className,
      )}
    >
      {children}
    </p>
  );
}
