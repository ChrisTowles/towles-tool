# Git Commit Command Requirements

## Overview

The `git-commit` command (alias: `gc`) provides a streamlined interface for creating Git commits with optional message parameters, git status display, and interactive staging prompts.

## Command Signature

```bash
# Direct commit with message
towles-tool gc "commit message"
towles-tool gc commit message without quotes

# Interactive mode
towles-tool gc
```

## Functional Requirements

### 1. Parameter Handling
- **Multiple arguments**: All command line arguments are joined with spaces to form the commit message
- **Single argument**: Used directly as the commit message
- **No arguments**: Enter interactive mode with manual message prompt

### 2. Git Status Display
- Show current repository status before committing
- Color-coded file categorization:
  - **Green**: Staged files ready for commit
  - **Yellow**: Modified files (not staged)
  - **Red**: Untracked files

### 3. Interactive Staging
- **No staged files**: Prompt user to stage files before committing
- **Staging options**:
  - Add all modified and untracked files (`git add .`)
  - Manual staging instruction with specific `git add <file>` guidance
  - Cancel operation if user chooses not to stage

### 4. Interactive Hotkeys
When prompting for commit message input, the following hotkeys must be available:

- **Ctrl+A**: Execute `git add .` to stage all modified and untracked files
  - Display feedback about files staged
  - Continue with message input after completion
  - Handle errors gracefully (e.g., permission issues, git repository errors)

- **Ctrl+S**: Show current git status without exiting prompt
  - Display color-coded status (staged/modified/untracked files)
  - Return to message input immediately after display
  - Use same color scheme as main status display

- **Ctrl+D**: Show git diff of currently staged changes
  - Display diff output in readable format
  - Show "No staged changes" if no files are staged
  - Return to message input after display

- **Ctrl+R**: Refresh and redisplay git status
  - Re-run git status check
  - Update display with current repository state
  - Useful after manual git operations in another terminal

**Hotkey Integration Requirements:**
- Hotkeys should not interfere with normal text input
- Clear visual feedback when hotkey is executed
- Preserve partially typed commit message during hotkey operations
- Allow user to continue typing message after hotkey completion
- Display available hotkeys as help text during input prompt

### 5. Commit Message Validation
- **Non-empty requirement**: Commit messages cannot be empty
- **Quote escaping**: Handle double quotes in commit messages properly
- **Interactive prompt**: Validate input during manual entry

### 6. Error Handling
- **Git status failure**: Exit with error if unable to read git status
- **No changes**: Graceful exit when working tree is clean
- **Commit failure**: Display error and exit if git commit fails
- **User cancellation**: Allow cancellation at prompt stages

## Technical Implementation

### File Location
- **Command file**: `src/commands/git-commit.ts`
- **CLI registration**: `src/index.ts` (command: `git-commit`, alias: `gc`)

## User Experience Flow

1. **Status Check**: Display current git repository status
2. **Staging Check**: If no staged files, offer to stage files
3. **Message Input**: Use provided arguments or prompt for message
4. **Commit Execution**: Execute git commit with proper error handling
5. **Success Confirmation**: Display success message upon completion

## Edge Cases

- **Clean working tree**: Inform user and exit gracefully
- **Empty message**: Prevent commits with empty messages
- **Special characters**: Handle quotes and special characters in commit messages
- **Git repository**: Assumes command is run within a git repository

## Examples

```bash
# Quick commit with message
towles-tool gc "fix: resolve authentication bug"

# Multi-word message without quotes
towles-tool gc fix resolve authentication bug

# Interactive mode
towles-tool gc
# Prompts for staging and message input
```
