import path from "node:path";
import consola from "consola";
import { DateTime } from "luxon";
import { getMondayOfWeek } from "../../utils/date-utils.js";
import type { JournalSettings } from "../../config/settings.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import type { JournalType } from "../../types/journal.js";

export interface GenerateJournalFileResult {
  fullPath: string;
  mondayDate: Date;
  currentDate: Date;
}

export interface GenerateJournalFileParams {
  date: Date;
  type: JournalType;
  title: string;
  journalSettings: JournalSettings;
}

export function resolvePathTemplate(
  template: string,
  title: string,
  date: Date,
  mondayDate: Date,
): string {
  const dateTime = DateTime.fromJSDate(date, { zone: "utc" });

  // Replace Luxon format tokens wrapped in curly braces
  return template.replace(/\{([^}]+)\}/g, (match, token) => {
    try {
      if (token === "title") {
        return title.toLowerCase().replace(/\s+/g, "-");
      }

      if (token.startsWith("monday:")) {
        const mondayToken = token.substring(7); // Remove 'monday:' prefix
        const mondayDateTime = DateTime.fromJSDate(mondayDate, { zone: "utc" });
        return mondayDateTime.toFormat(mondayToken);
      }

      const result = dateTime.toFormat(token);
      // Check if the result contains suspicious patterns that indicate invalid tokens
      // This is a heuristic to detect when Luxon produces garbage output for invalid tokens
      const isLikelyInvalid =
        token.includes("invalid") ||
        result.length > 20 || // Very long results are likely garbage
        (result.length > token.length * 2 && /\d{10,}/.test(result)) || // Contains very long numbers
        result.includes("UTC");

      if (isLikelyInvalid) {
        consola.warn(`Invalid date format token: ${token}`);
        return match;
      }
      return result;
    } catch (error) {
      consola.warn(`Invalid date format token: ${token}`);
      return match; // Return original token if format is invalid
    }
  });
}

/**
 * Generate journal file info for different types using individual path templates
 */
export function generateJournalFileInfoByType({
  journalSettings,
  date = new Date(),
  type,
  title,
}: GenerateJournalFileParams): GenerateJournalFileResult {
  const currentDate = new Date(date);

  let templatePath: string = "";
  let mondayDate: Date = getMondayOfWeek(currentDate);

  switch (type) {
    case JOURNAL_TYPES.DAILY_NOTES: {
      const monday = getMondayOfWeek(currentDate);
      templatePath = journalSettings.dailyPathTemplate;
      mondayDate = monday;
      break;
    }
    case JOURNAL_TYPES.MEETING: {
      templatePath = journalSettings.meetingPathTemplate;
      mondayDate = currentDate;
      break;
    }
    case JOURNAL_TYPES.NOTE: {
      templatePath = journalSettings.notePathTemplate;
      mondayDate = currentDate;
      break;
    }
    default:
      throw new Error(`Unknown JournalType: ${type}`);
  }

  // Resolve the path template and extract directory structure
  const resolvedPath = resolvePathTemplate(templatePath, title, currentDate, mondayDate);

  // Join baseFolder with the resolved path
  const fullPath = path.join(journalSettings.baseFolder, resolvedPath);

  return {
    currentDate: currentDate,
    fullPath: fullPath,
    mondayDate,
  } satisfies GenerateJournalFileResult;
}
