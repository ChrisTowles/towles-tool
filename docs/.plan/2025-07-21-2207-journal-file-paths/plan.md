# Journal File Paths Configuration Plan

## User Request
Modify the journal feature to allow the user to specify paths for each of the file types in their settings file.

## Plan Status
- Created: 2025-07-21-2207
- Status: Plan Phase
- Current Phase: Plan

## Problem Statement
Currently, users can only configure the root journal directory (`journalDir`), but the internal organization is fixed:
- Daily notes: `{journalDir}/{year}/daily-notes/`
- Meeting notes: `{journalDir}/{year}/meetings/`  
- General notes: `{journalDir}/{year}/notes/`

Users need more flexibility to customize file paths for each journal type to match their preferred organization system.

## Current Architecture Analysis

### Journal Types
- `DAILY_NOTES` ('daily-notes'): Weekly files with daily sections
- `MEETING` ('meeting'): Structured meeting notes with optional titles
- `NOTE` ('note'): General notes with optional titles

### Current Path Logic (src/commands/journal.tsx)
```typescript
// Fixed path structure
const basePath = path.join(journalDir, year.toString(), typeFolder);
// Where typeFolder is hardcoded as:
// - 'daily-notes' for DAILY_NOTES
// - 'meetings' for MEETING  
// - 'notes' for NOTE
```

### Settings System (src/config/settings.ts)
- Uses Zod v4 schemas with nested settings
- Current `JournalSettingsSchema` only has `journalDir: string`
- Follows pattern of nested schemas for logical grouping
- Auto-creates settings file with user confirmation

## High-Level Solution Overview

### Option 1: Path Templates with Variables
Allow users to specify path templates using variables like `{year}`, `{type}`, etc.
```json
{
  "journalSettings": {
    "journalDir": "~/journal",
    "pathTemplates": {
      "daily": "{journalDir}/{year}/daily-notes",
      "meeting": "{journalDir}/{year}/meetings", 
      "note": "{journalDir}/{year}/notes"
    }
  }
}
```

### Option 2: Full Path Overrides
Allow complete path override for each type:
```json
{
  "journalSettings": {
    "journalDir": "~/journal",
    "typePaths": {
      "daily": "~/Documents/WeeklyLogs",
      "meeting": "~/work/meetings/{year}",
      "note": "~/Documents/notes"
    }
  }
}
```

### Option 3: Configurable Components
Allow configuration of individual path components:
```json
{
  "journalSettings": {
    "journalDir": "~/journal",
    "pathStructure": {
      "useYearFolders": true,
      "folderNames": {
        "daily": "weekly-logs",
        "meeting": "meetings",
        "note": "notes"
      }
    }
  }
}
```

## Files Requiring Modification

### Core Implementation
- `src/config/settings.ts`: Update `JournalSettingsSchema` with new path settings
- `src/commands/journal.tsx`: Modify path generation logic in `generateJournalFileInfoByType()`
- `src/commands/journal.test.tsx`: Update tests for new path generation

### Supporting Files
- `src/config/context.ts`: May need updates if context interface changes
- `src/config/settings.ts`: controls user settings and confirmation

## Similar Features Analysis
The codebase already demonstrates good patterns for:
- Nested settings schemas (`JournalSettingsSchema`)
- Path handling with `homedir()` expansion
- User confirmation for new settings
- Type-safe configuration access

## Technical Constraints
- Must maintain backward compatibility with existing settings
- Path resolution must handle `~` expansion
- Directory creation must work with new path structures
- File naming conventions should remain consistent

## Integration Points
- Settings loading: `loadSettings()` in settings.ts
- Context system: Journal commands access paths via context
- React components: Settings display in confirmation UI

## Discovery Answers
### Q2: Template Variables
**Answer: Core variables + Luxon date formatting**
- Core variables: `{type}` 
- Date variables using Luxon format tokens (e.g., `{yyyy}`, `{MM}`, `{dd}`, `{LLL}`)
- Users can specify any Luxon format pattern for maximum date flexibility
- This allows patterns like `{yyyy-MM}` for year-month folders, `{LLL}` for month names, etc.
- No `{journalDir}` variable needed - path templates are relative to `journalDir`

### Q3: Default Path Templates
**Answer: Simplified defaults matching current behavior**
```json
{
  "journalSettings": {
    "daily": "~/journal/{yyyy}/daily-notes/",
    "meeting": "~/journal/{yyyy}/meetings", 
    "note": "~/journal/{yyyy}/notes"
  }
}
```

### Integration Points
- Settings access: `context.settingsFile.settings.journalSettings.pathTemplates.daily`
- Path resolution: Combine `journalDir` + resolved template
- File creation: Use resolved paths in `createJournalFile()` function

### Error Handling
- Invalid Luxon format tokens: Log warning and leave token unresolved
- Missing path templates: Fall back to hardcoded defaults
- Invalid paths: Standard directory creation error handling