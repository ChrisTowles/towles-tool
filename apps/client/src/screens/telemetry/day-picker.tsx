import { CalendarDotsIcon } from "@phosphor-icons/react";
import { Button, DatePicker, Popover } from "@cloudflare/kumo";

/** Telemetry days are local `YYYY-MM-DD` keys; parse at local midnight so the
 * calendar highlights the same day it names. */
function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDay(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The header's day picker: only days with a log on disk are selectable. */
export function DayPicker({
  days,
  day,
  onDay,
}: {
  days: string[] | null;
  day: string | null;
  onDay: (day: string) => void;
}) {
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label="Telemetry day"
            icon={<CalendarDotsIcon className="size-3.5" />}
            disabled={days === null || days.length === 0}
            className="w-40 justify-start"
          />
        }
      >
        {day ?? (days === null ? "Loading…" : "No logs")}
      </Popover.Trigger>
      <Popover.Content align="end" className="p-2">
        <DatePicker
          mode="single"
          selected={day ? parseDay(day) : undefined}
          defaultMonth={day ? parseDay(day) : undefined}
          disabled={(date) => !days?.includes(formatDay(date))}
          onChange={(date) => {
            if (!date) return;
            onDay(formatDay(date));
          }}
        />
      </Popover.Content>
    </Popover>
  );
}
