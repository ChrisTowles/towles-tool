import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import consola from "consola";
import { colors } from "consola/utils";
import { formatDate, getWeekInfo } from "../../utils/date-utils.js";
import { ensureDirectoryExists } from "./fs.js";

// Default template file names
const TEMPLATE_FILES = {
  dailyNotes: "daily-notes.md",
  meeting: "meeting.md",
  note: "note.md",
} as const;

/**
 * Load template from external file or return null if not found
 */
export function loadTemplate(templateDir: string, templateFile: string): string | null {
  const templatePath = path.join(templateDir, templateFile);
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, "utf8");
  }
  return null;
}

/**
 * Get default template content for initial setup
 */
function getDefaultDailyNotesTemplate(): string {
  return `# Journal for Week {monday:yyyy-MM-dd}

## {monday:yyyy-MM-dd} Monday

## {tuesday:yyyy-MM-dd} Tuesday

## {wednesday:yyyy-MM-dd} Wednesday

## {thursday:yyyy-MM-dd} Thursday

## {friday:yyyy-MM-dd} Friday
`;
}

function getDefaultMeetingTemplate(): string {
  return `# Meeting: {title}

**Date:** {date}
**Time:** {time}
**Attendees:**

## Agenda

-

## Notes

## Action Items

- [ ]

## Follow-up
`;
}

function getDefaultNoteTemplate(): string {
  return `# {title}

**Created:** {date} {time}

## Summary

## Details

## References
`;
}

/**
 * Initialize template directory with default templates (first run)
 */
export function ensureTemplatesExist(templateDir: string): void {
  ensureDirectoryExists(templateDir);

  const templates = [
    { file: TEMPLATE_FILES.dailyNotes, content: getDefaultDailyNotesTemplate() },
    { file: TEMPLATE_FILES.meeting, content: getDefaultMeetingTemplate() },
    { file: TEMPLATE_FILES.note, content: getDefaultNoteTemplate() },
  ];

  for (const { file, content } of templates) {
    const templatePath = path.join(templateDir, file);
    if (!existsSync(templatePath)) {
      writeFileSync(templatePath, content, "utf8");
      consola.info(`Created default template: ${colors.cyan(templatePath)}`);
    }
  }
}

/**
 * Render template with variables
 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    return vars[key] ?? match;
  });
}

/**
 * Create initial journal content with date header
 */
export function createJournalContent({
  mondayDate,
  templateDir,
}: {
  mondayDate: Date;
  templateDir?: string;
}): string {
  const weekInfo = getWeekInfo(mondayDate);

  // Try external template first
  if (templateDir) {
    const externalTemplate = loadTemplate(templateDir, TEMPLATE_FILES.dailyNotes);
    if (externalTemplate) {
      return renderTemplate(externalTemplate, {
        "monday:yyyy-MM-dd": formatDate(weekInfo.mondayDate),
        "tuesday:yyyy-MM-dd": formatDate(weekInfo.tuesdayDate),
        "wednesday:yyyy-MM-dd": formatDate(weekInfo.wednesdayDate),
        "thursday:yyyy-MM-dd": formatDate(weekInfo.thursdayDate),
        "friday:yyyy-MM-dd": formatDate(weekInfo.fridayDate),
      });
    }
  }

  // Fallback to hardcoded template
  const content = [`# Journal for Week ${formatDate(mondayDate)}`];
  content.push(``);
  content.push(`## ${formatDate(weekInfo.mondayDate)} Monday`);
  content.push(``);
  content.push(`## ${formatDate(weekInfo.tuesdayDate)} Tuesday`);
  content.push(``);
  content.push(`## ${formatDate(weekInfo.wednesdayDate)} Wednesday`);
  content.push(``);
  content.push(`## ${formatDate(weekInfo.thursdayDate)} Thursday`);
  content.push(``);
  content.push(`## ${formatDate(weekInfo.fridayDate)} Friday`);
  content.push(``);

  return content.join("\n");
}

/**
 * Create meeting template content
 */
export function createMeetingContent({
  title,
  date,
  templateDir,
}: {
  title?: string;
  date: Date;
  templateDir?: string;
}): string {
  const dateStr = formatDate(date);
  const timeStr = date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const meetingTitle = title || "Meeting";

  // Try external template first
  if (templateDir) {
    const externalTemplate = loadTemplate(templateDir, TEMPLATE_FILES.meeting);
    if (externalTemplate) {
      return renderTemplate(externalTemplate, {
        title: meetingTitle,
        date: dateStr,
        time: timeStr,
      });
    }
  }

  // Fallback to hardcoded template
  const content = [`# Meeting: ${meetingTitle}`];
  content.push(``);
  content.push(`**Date:** ${dateStr}`);
  content.push(`**Time:** ${timeStr}`);
  content.push(`**Attendees:** `);
  content.push(``);
  content.push(`## Agenda`);
  content.push(``);
  content.push(`- `);
  content.push(``);
  content.push(`## Notes`);
  content.push(``);
  content.push(`## Action Items`);
  content.push(``);
  content.push(`- [ ] `);
  content.push(``);
  content.push(`## Follow-up`);
  content.push(``);

  return content.join("\n");
}

/**
 * Create note template content
 */
export function createNoteContent({
  title,
  date,
  templateDir,
}: {
  title?: string;
  date: Date;
  templateDir?: string;
}): string {
  const dateStr = formatDate(date);
  const timeStr = date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const noteTitle = title || "Note";

  // Try external template first
  if (templateDir) {
    const externalTemplate = loadTemplate(templateDir, TEMPLATE_FILES.note);
    if (externalTemplate) {
      return renderTemplate(externalTemplate, {
        title: noteTitle,
        date: dateStr,
        time: timeStr,
      });
    }
  }

  // Fallback to hardcoded template
  const content = [`# ${noteTitle}`];
  content.push(``);
  content.push(`**Created:** ${dateStr} ${timeStr}`);
  content.push(``);
  content.push(`## Summary`);
  content.push(``);
  content.push(`## Details`);
  content.push(``);
  content.push(`## References`);
  content.push(``);

  return content.join("\n");
}
