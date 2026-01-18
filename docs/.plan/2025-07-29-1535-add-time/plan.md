# Plan: Add Time Command

## User Request

Add a new command to add time

## Plan Status

- Phase: Plan
- Created: 2025-07-29 15:35
- Last Updated: 2025-07-29 15:35
- Status: Planning

## Exploration Results

### Existing Command Architecture

- **Commands Location**: `/src/commands/{command-name}.ts` with co-located tests
- **Registration**: `parseArgs.ts` defines command structure, `index.ts` routes commands
- **Pattern**: `async function commandName(context: Context, args: CommandArgs): Promise<void>`
- **Context Available**: `cwd`, `settingsFile`, `debug` flag

### Existing Time/Date Utilities

- **`date-utils.ts`**: Week calculations, date formatting (YYYY-MM-DD), Monday-based weeks
- **Luxon Library**: Already available, used for timezone-aware date operations
- **Patterns**: UTC normalization, midnight time normalization for date-only ops

### Popular Time CLI Patterns Research

- **Common Commands**: `start`, `stop`, `status`, `list`, `report`
- **Data Storage**: JSON files in user config directory
- **Time Formats**: Duration display (2h 30m), timestamps, human-readable
- **Advanced Features**: Tags, projects, notes, pause/resume

## Problem Statement

The user wants to add time-related functionality to towles-tool. Based on CLI patterns research, this likely involves time tracking capabilities that complement the existing productivity tools (journal, git-commit).

## High-Level Solution Overview

Implement a `time` command with subcommands following the established towles-tool patterns:

- Leverage existing Luxon library for time operations
- Use JSON storage in settings directory
- Follow yargs subcommand pattern like `journal`
- Integrate with existing Context and settings system

## Technical Architecture

### File Structure

```
src/
├── commands/
│   ├── time.ts                 # Main time command implementation
│   └── time.test.ts           # Unit tests
├── utils/
│   └── time-utils.ts          # Time calculations, formatting
└── config/
     └── settings.ts           # Add time settings schema
```

### Command Registration

- Add `TimeArgs` interface to `parseArgs.ts`
- Register subcommands: `start`, `stop`, `status`, `list`, `report`
- Add to `ParsedArgs` union type and `index.ts` routing

### Data Model (Initial)

```typescript
interface TimeEntry {
  id: string;
  project?: string;
  description?: string;
  startTime: number; // timestamp
  endTime?: number; // timestamp, null if active
  tags: string[];
  totalMs: number; // calculated duration
}

interface TimeData {
  entries: TimeEntry[];
  activeEntry?: string; // entry ID
}
```

## Integration Points

- **Settings**: Add time configuration to existing settings schema
- **Context**: Use existing context system for cwd, settings access
- **Utilities**: Extend existing date-utils.ts patterns
- **Error Handling**: Follow consola error patterns from other commands

## Initial Implementation Plan

### Phase 1: Core Infrastructure

1. Create `time-utils.ts` with duration formatting, time calculations
2. Add time settings schema to `config/settings.ts`
3. Create basic `time.ts` command structure

### Phase 2: Basic Commands

1. Implement `time start [project]` - start time tracking
2. Implement `time stop` - stop active tracking
3. Implement `time status` - show current timer
4. Add command registration to parseArgs.ts and index.ts

### Phase 3: Data Management

1. Implement JSON file storage in user config directory
2. Add time entry CRUD operations
3. Handle concurrent access and file locking

### Phase 4: Advanced Features

1. Implement `time list` - show recent entries
2. Implement `time report` - generate time summaries
3. Add project/tag support
4. Add manual time entry capabilities

### Phase 5: Testing & Documentation

1. Write comprehensive unit tests
2. Update requirements documentation
3. Test integration with existing commands

## Questions for User
