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

interface weekInfo {
  mondayDate: Date;
  tuesdayDate: Date;
  wednesdayDate: Date;
  thursdayDate: Date;
  fridayDate: Date;
}

export function getWeekInfo(mondayDate: Date): weekInfo {
  const tuesdayDate = new Date(mondayDate);
  tuesdayDate.setDate(mondayDate.getDate() + 1);
  const wednesdayDate = new Date(mondayDate);
  wednesdayDate.setDate(mondayDate.getDate() + 2);
  const thursdayDate = new Date(mondayDate);
  thursdayDate.setDate(mondayDate.getDate() + 3);
  const fridayDate = new Date(mondayDate);
  fridayDate.setDate(mondayDate.getDate() + 4);

  return {
    mondayDate,
    tuesdayDate,
    wednesdayDate,
    thursdayDate,
    fridayDate,
  };
}

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Generate journal filename based on Monday of the current week
 * Format: YYYY-MM-DD-week.md (always uses Monday's date)
 */
export function generateJournalFilename(date: Date = new Date()): string {
  const monday = getMondayOfWeek(new Date(date));
  return `${formatDate(monday)}-week.md`;
}
