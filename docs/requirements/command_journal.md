# Journal Command Requirements

## Overview
The journal command provides a comprehensive system for creating and managing different types of markdown files with structured templates for daily notes, meetings, and general notes.

## Commands and Aliases
- Primary command: `journal`
- Alias: `j`

## Journal Types

### Daily Notes (`journal daily-notes` or `journal`)
- **Purpose**: Weekly files with daily sections for ongoing work and notes
- **File structure**: `YYYY/daily-notes/YYYY-MM-DD-week-log.md` (Monday's date)
- **Template**: Includes sections for Monday through Friday with date headers
- **Use case**: Regular daily journaling, work logs, scratch pad for notes

### Meeting Files (`journal meeting [title]`)
- **Purpose**: Structured meeting notes with agenda and action items
- **File structure**: `YYYY/meetings/YYYY-MM-DD-HHMM-meeting-[title].md`
- **Template**: Includes Date, Time, Attendees, Agenda, Notes, Action Items, and Follow-up sections
- **Use case**: Meeting preparation, note-taking, and action item tracking

### Note Files (`journal note [title]`)
- **Purpose**: General-purpose notes with structured sections
- **File structure**: `YYYY/notes/YYYY-MM-DD-HHMM-note-[title].md`
- **Template**: Includes Summary, Details, and References sections
- **Use case**: Research notes, documentation, general information capture

## Supported Commands
- `journal` or `journal daily-notes` - Create/open current week's daily notes
- `journal meeting [title]` - Create a new meeting file with optional title
- `journal note [title]` - Create a new note file with optional title

## Configuration
Journal files are created in a configurable directory structure and automatically opened in the user's preferred editor as specified in the configuration file.

## File Management
- If a file already exists, it will be opened rather than recreated
- Files are organized by year and type for easy navigation and archival
- Templates are automatically applied to new files based on their type