import { describe, expect, it } from "vitest";
import { formatDate, generateJournalFilename, getMondayOfWeek, getWeekInfo } from "./date-utils";

describe("date utilities", () => {
  it("should get Monday of the week correctly", () => {
    // Test with a Wednesday (July 9, 2025)
    const wednesday = new Date(2025, 6, 9); // July 9, 2025
    const monday = getMondayOfWeek(wednesday);
    expect(formatDate(monday)).toBe("2025-07-07");

    // Test with a Friday (July 11, 2025)
    const friday = new Date(2025, 6, 11); // July 11, 2025
    const mondayFromFriday = getMondayOfWeek(friday);
    expect(formatDate(mondayFromFriday)).toBe("2025-07-07");

    // Test with a Sunday (July 13, 2025) - should return Monday of previous week
    const sunday = new Date(2025, 6, 13); // July 13, 2025
    const mondayFromSunday = getMondayOfWeek(sunday);
    expect(formatDate(mondayFromSunday)).toBe("2025-07-07");

    // Test with a Monday (July 7, 2025)
    const actualMonday = new Date(2025, 6, 7); // July 7, 2025
    const mondayFromMonday = getMondayOfWeek(actualMonday);
    expect(formatDate(mondayFromMonday)).toBe("2025-07-07");
  });

  it("should generate correct journal filename", () => {
    // Test with different days in the same week
    const wednesday = new Date(2025, 6, 9); // July 9, 2025
    const filename = generateJournalFilename(wednesday);
    expect(filename).toBe("2025-07-07-week.md");

    const friday = new Date(2025, 6, 11); // July 11, 2025
    const filenameFromFriday = generateJournalFilename(friday);
    expect(filenameFromFriday).toBe("2025-07-07-week.md");
  });

  it("should format date correctly", () => {
    // Use local date constructor (year, month-1, day), not ISO string which is UTC
    const date = new Date(2025, 6, 7); // July 7, 2025 in local time
    expect(formatDate(date)).toBe("2025-07-07");
  });

  it("should get week info correctly", () => {
    // Test with Monday July 7, 2025
    const monday = new Date(2025, 6, 7);
    const weekInfo = getWeekInfo(monday);

    expect(formatDate(weekInfo.mondayDate)).toBe("2025-07-07");
    expect(formatDate(weekInfo.tuesdayDate)).toBe("2025-07-08");
    expect(formatDate(weekInfo.wednesdayDate)).toBe("2025-07-09");
    expect(formatDate(weekInfo.thursdayDate)).toBe("2025-07-10");
    expect(formatDate(weekInfo.fridayDate)).toBe("2025-07-11");
  });

  it("should handle edge cases correctly", () => {
    // Test with year boundary - Monday December 30, 2024
    const mondayEndOfYear = new Date(2024, 11, 30);
    const weekInfo = getWeekInfo(mondayEndOfYear);

    expect(formatDate(weekInfo.mondayDate)).toBe("2024-12-30");
    expect(formatDate(weekInfo.tuesdayDate)).toBe("2024-12-31");
    expect(formatDate(weekInfo.wednesdayDate)).toBe("2025-01-01");
    expect(formatDate(weekInfo.thursdayDate)).toBe("2025-01-02");
    expect(formatDate(weekInfo.fridayDate)).toBe("2025-01-03");
  });

  it("should handle month boundary correctly", () => {
    // Test with month boundary - Monday January 29, 2025
    const mondayEndOfMonth = new Date(2025, 0, 27);
    const weekInfo = getWeekInfo(mondayEndOfMonth);

    expect(formatDate(weekInfo.mondayDate)).toBe("2025-01-27");
    expect(formatDate(weekInfo.tuesdayDate)).toBe("2025-01-28");
    expect(formatDate(weekInfo.wednesdayDate)).toBe("2025-01-29");
    expect(formatDate(weekInfo.thursdayDate)).toBe("2025-01-30");
    expect(formatDate(weekInfo.fridayDate)).toBe("2025-01-31");
  });

  it("should handle getMondayOfWeek with different timezones", () => {
    // Test with a specific time to ensure hours are reset
    const dateWithTime = new Date(2025, 6, 9, 15, 30, 45); // July 9, 2025 at 3:30:45 PM
    const monday = getMondayOfWeek(dateWithTime);

    expect(formatDate(monday)).toBe("2025-07-07");
    expect(monday.getHours()).toBe(0);
    expect(monday.getMinutes()).toBe(0);
    expect(monday.getSeconds()).toBe(0);
    expect(monday.getMilliseconds()).toBe(0);
  });

  it("should handle formatDate with different times", () => {
    // Test that formatDate only considers the date part
    const dateWithTime = new Date(2025, 6, 7, 10, 30, 45); // July 7, 2025 at 10:30:45 AM
    expect(formatDate(dateWithTime)).toBe("2025-07-07");
  });
});
