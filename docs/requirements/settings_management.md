# Settings Management Requirements

## Overview

The settings management system provides user configuration storage and management for towles-tool. It includes automatic settings file creation with user confirmation, default value management, and settings persistence.

## Core Components

### Settings File Location
- **Primary settings file**: `~/.config/towles-tool/towles-tool.settings.json`
- **Settings directory**: `~/.config/towles-tool/`
- **Auto-creation**: Directory and file created automatically when needed

### Settings Schema

The settings are defined using Zod schemas and process with zod for validation.

## Functional Requirements

### 1. Settings Loading (`loadSettings`)
- **Async operation**: Returns `Promise<LoadedSettings>`
- **File existence check**: Verify if settings file exists
- **User confirmation**: Prompt user before creating settings file if missing
- **Default values**: Apply schema defaults for missing settings
- **Error handling**: Collect and report parsing/loading errors
- **JSON Comments**: Support JSON with comments using `strip-json-comments`

### 2. Settings Creation Confirmation
- **Interactive prompt**: Use `@inkjs/ui` ConfirmInput component
- **User choice**: Allow user to confirm or decline settings file creation
- **Clear messaging**: Display settings file path in confirmation prompt
- **Graceful handling**: Continue operation even if user declines creation

### 3. Settings File Management
- **Auto-creation**: Create settings directory if missing
- **JSON formatting**: Pretty-print settings with 2-space indentation
- **Error handling**: Log errors during save operations
- **Atomic operations**: Ensure settings updates are complete or fail entirely

### 4. Settings Updates (`setValue`)
- **Type-safe updates**: Use generic constraints for setting keys
- **Immediate persistence**: Save settings to file after updates
- **In-memory sync**: Update both in-memory and file representations
- **Validation**: Ensure updated values conform to schema

## Technical Requirements

### 1. Type Safety
- **Branded types**: Use Zod v4 with branded types for validation
- **Generic constraints**: Type-safe setting key/value operations
- **Interface definitions**: Clear TypeScript interfaces for all settings structures

### 2. Error Handling
- **Error collection**: Accumulate errors without failing entire load operation
- **Error reporting**: Provide detailed error messages with file paths
- **Graceful degradation**: Use defaults when settings loading fails

### 3. UI Integration
- **React components**: Use Ink-based UI components for confirmations
- **Async rendering**: Handle async UI operations for confirmations
- **Component separation**: Keep UI logic separate from core settings logic

## Error Scenarios
- **File parsing errors**: Invalid JSON syntax
- **Schema validation errors**: Invalid setting values
- **File system errors**: Permission issues, disk space
- **User cancellation**: User declines to create settings file