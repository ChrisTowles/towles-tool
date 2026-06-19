/**
 * Get the Monday of the week for a given date
 */
export function getMondayOfWeek(date: Date): Date {
  const newDate = new Date(date);
  const day = newDate.getDay();
  const diff = newDate.getDate() - day + (day === 0 ? -6 : 1);
  newDate.setDate(diff);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
}

interface WeekInfo {
  mondayDate: Date;
  tuesdayDate: Date;
  wednesdayDate: Date;
  thursdayDate: Date;
  fridayDate: Date;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(date.getDate() + days);
  return result;
}

export function getWeekInfo(mondayDate: Date): WeekInfo {
  return {
    mondayDate,
    tuesdayDate: addDays(mondayDate, 1),
    wednesdayDate: addDays(mondayDate, 2),
    thursdayDate: addDays(mondayDate, 3),
    fridayDate: addDays(mondayDate, 4),
  };
}

/**
 * Format date as YYYY-MM-DD in local timezone
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-CA");
}

/**
 * Generate journal filename based on Monday of the current week
 * Format: YYYY-MM-DD-week.md (always uses Monday's date)
 */
export function generateJournalFilename(date: Date = new Date()): string {
  const monday = getMondayOfWeek(date);
  return `${formatDate(monday)}-week.md`;
}
