# Configuration Command Requirements

## Overview

The `config` command (alias: `cfg`) provides interface for managing and displaying the towles-tool configuration settings. It allows users to view current configuration values and understand the configuration file location.

## Command Signature

```bash
# Show current configuration
towles-tool config
towles-tool cfg
```

## Functional Requirements

### 1. Configuration Display
- **Show configuration file path**: Display the location of the active configuration file
- **Display all configuration values**: Show current configuration in a readable JSON format

### 2. Configuration Structure
- **User configuration interface**: Defined by `UserConfig` type in `src/config.ts`
- **Available settings**:
  - `journalDir`: Directory path for journal files (default: `~/journal`)
  - `editor`: Default editor command (default: `code`)

### 3. Configuration Management
- **Config file creation**: Automatically prompt to create config if none exists
- **Default values**: Use sensible defaults when config is first created
- **Config file location**: `~/.config/towles-tool/towles-tool.config.ts`
- **Auto-update**: Sync configuration with defaults when loading

### 4. Error Handling
- **Config load failure**: Exit with error if configuration cannot be loaded
- **Invalid configuration**: Display helpful error messages for malformed config
- **File permissions**: Handle cases where config directory is not writable

## Technical Implementation

### File Locations
- **Command registration**: `src/index.ts` (command: `config`, alias: `cfg`)
- **Configuration logic**: `src/config.ts`
- **Config interface**: `UserConfig` and `Config` types in `src/config.ts`

### Dependencies
- **c12**: Configuration loading and management
- **consola**: Logging and user prompts
- **homedir**: Home directory resolution

## User Experience Flow

1. **Execute command**: User runs `towles-tool config` or `towles-tool cfg`
2. **Load configuration**: System loads current configuration from file
3. **Display information**: Show configuration file path and current settings
4. **Format output**: Present information in readable, color-coded format


## Edge Cases

- **Missing config file**: Prompt user to create new configuration
- **Corrupted config**: Display error and suggest recreation
- **Permission issues**: Handle read/write permission errors gracefully
- **Invalid JSON/TS**: Provide clear error messages for malformed config

