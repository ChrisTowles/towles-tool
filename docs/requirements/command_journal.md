# Journal Command Requirements

## Overview
The journal command provides functionality for creating and managing different types of journal entries including daily notes, meeting notes, and general notes. The command supports configurable file organization through path templates.

## Command Syntax

### Main Commands
- `tt journal` or `tt j` - Create/open daily journal (default behavior)
- `tt journal daily` - Create/open daily journal (explicit)
- `tt journal meeting [title]` - Create meeting note with optional title
- `tt journal note [title]` - Create general note with optional title


### Aliases
- `j` - Alias for `journal`
- `today` - Alias for `daily`

## Journal Types

### Daily Notes (`daily-notes`)
- **Purpose**: Weekly journal files organized by Monday of each week
- **File Format**: `YYYY-MM-DD-week-log.md` (Monday date)
- **Template**: Includes sections for each weekday (Monday-Friday)
- **Default Path**: `{journalDir}/{yyyy}/daily-notes/`

### Meeting Notes (`meeting`)
- **Purpose**: Structured meeting notes with agenda and action items
- **File Format**: `YYYY-MM-DD-HHMM-meeting[-title].md`
- **Template**: Includes Date, Time, Attendees, Agenda, Notes, Action Items, Follow-up sections
- **Default Path**: `{journalDir}/{yyyy}/meetings/`

### General Notes (`note`)
- **Purpose**: General-purpose notes for any topic
- **File Format**: `YYYY-MM-DD-HHMM-note[-title].md`
- **Template**: Includes Summary, Details, References sections
- **Default Path**: `{journalDir}/{yyyy}/notes/`


### Path Templates
Path templates allow users to customize the directory structure for each journal type using Luxon date format tokens wrapped in curly braces. This enables mixing literal text with dynamic date values.

#### Token Syntax
All date format tokens **must be wrapped in curly braces** `{}` to be processed. Text outside of braces is preserved as literal text.

#### Supported Tokens
- `{title}` - Title slug (converts spaces to hyphens, lowercase) (e.g., "sprint-planning")


#### Supported Date Format Tokens
- `{yyyy}` - 4-digit year (e.g., "2024")
- `{yy}` - 2-digit year (e.g., "24")
- `{MM}` - 2-digit month (e.g., "07")
- `{M}` - 1-digit month (e.g., "7")
- `{LLL}` - Short month name (e.g., "Jul")
- `{LLLL}` - Full month name (e.g., "July")
- `{dd}` - 2-digit day (e.g., "22")
- `{d}` - 1-digit day (e.g., "22")
- `{EEE}` - Short day name (e.g., "Mon")
- `{EEEE}` - Full day name (e.g., "Monday")
- `{HH}` - 24-hour format hour (e.g., "14")
- `{H}` - 24-hour format hour, no padding (e.g., "14")
- `{mm}` - Minutes (e.g., "30")
- `{m}` - Minutes, no padding (e.g., "30")
- `{ss}` - Seconds (e.g., "45")
- `{s}` - Seconds, no padding (e.g., "45")
- `{q}` - Quarter number (e.g., "1")
- `{qq}` - Zero-padded quarter (e.g., "01")
- `{W}` - Week of year (e.g., "11")

- Any other valid [Luxon format tokens](https://moment.github.io/luxon/#/formatting)

#### Template Examples

**Basic Date Patterns**:
- `{yyyy}-{MM}-{dd}` → `2024-03-15`
- `{yyyy}-{MM}-{dd}-{title}.md` → `2024-03-15-sprint-planning.md`
- `{LLL}/{dd}` → `Mar/15`

**Mixed Literal Text and Tokens**:
- `journal/{yyyy}/daily-notes/{MM}-{title}.md` → `journal/2024/daily-notes/03-sprint-planning.md`
- `notes-{yyyy}-{LLL}-{dd}.md` → `notes-2024-Mar-15.md`
- `meeting-{yyyy}-{MM}-{dd}-{HH}{mm}.md` → `meeting-2024-03-15-1430.md`

**Title Token Examples**:
- `{yyyy}/{MM}/meetings/{dd}-{title}.md` → `2024/03/meetings/15-sprint-planning.md`
- `notes/{yyyy}/{LLL}/{title}-{dd}.md` → `notes/2024/Mar/project-ideas-15.md`
- `{yyyy}-{MM}-{dd}-{title}.md` → `2024-03-15-team-retrospective.md`

**Complex Organizational Patterns**:
- `archive/{yyyy}/{LLL}/week-{W}.md` → `archive/2024/Mar/week-11.md`
- `Q{q}-{yyyy}/M{MM}/daily.md` → `Q1-2024/M03/daily.md`
- `logs/{EEEE}_{dd}_{LLL}_{yyyy}.md` → `logs/Friday_15_Mar_2024.md`

**File Path Templates**:
- `{yyyy}/{MM}/{dd}.md` → `2024/03/15.md`
- `backup-{yyyy}-{MM}-{dd}-{HH}-{mm}-{ss}.zip` → `backup-2024-03-15-14-30-45.zip`

## Configuration

### Settings Schema
```json
{
  "journalSettings": {
    "dailyPathTemplate": "~/journal/{yyyy}/{MM}/daily-notes/{yyyy}-{MM}-{dd}-daily-notes.md",
    "meetingPathTemplate": "~/journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md",
    "notePathTemplate": "~/journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md"
  }
}
```

### Default Configuration
- **Daily Path**: `~/journal/{yyyy}/{MM}/daily-notes/{yyyy}-{MM}-{dd}-daily-notes.md`
- **Meeting Path**: `~/journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md`
- **Note Path**: `~/journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md`


**Example Outputs**:
- **Meeting**: `~/work/meetings/2024/Q1/sprint-planning-03-15.md`
- **Note**: `~/notes/2024/Mar/project-ideas-Friday-15.md`


## Behavior

### File Creation
1. **Check Configuration**: Load path templates from user settings
2. **Resolve Paths**: Apply date formatting to path templates using curly brace token replacement
3. **Ensure Directories**: Create directory structure if it doesn't exist
4. **Generate Content**: Create appropriate template content if file doesn't exist
5. **Open Editor**: Launch configured editor with the file

### Path Resolution Process
1. **Template Loading**: Retrieve appropriate template (daily/meeting/note) from user settings
2. **Token Replacement**: Process `{token}` patterns using Luxon date formatting
3. **Literal Preservation**: Keep non-braced text unchanged as literal path components
4. **Path Validation**: Extract directory path and filename from resolved template
5. **Directory Creation**: Ensure all parent directories exist before file creation

### File Naming
- **Daily**: Uses Monday date of the current week
- **Meeting/Note**: Uses current date and time, with optional title slug

## Error Handling

### Invalid Path Templates
- **Invalid Tokens**: System detects invalid Luxon format tokens and preserves them unchanged with warning
- **Token Syntax**: Non-braced text is preserved as literal text; only `{token}` patterns are processed
- **Malformed Tokens**: Tokens producing suspicious output (very long strings, UTC references) are rejected
- **Missing Templates**: Falls back to default templates if user templates are not provided
- **Path Creation Failure**: Standard directory creation error handling

### Editor Integration
- **Missing Editor**: Warns user with configuration guidance
- **Editor Launch Failure**: Graceful degradation with error message

## Integration

### Settings Management
- Auto-creates settings file with user confirmation if missing
- Updates settings schema with default path templates
- Preserves existing settings during updates

### Context System
- Accesses settings through application context
- Resolves paths using context-provided templates
- Integrates with preferred editor settings

