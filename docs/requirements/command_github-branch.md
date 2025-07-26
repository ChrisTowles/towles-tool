# GitHub Branch Command Requirements

## Overview

The `github-branch` command provides an integrated workflow for creating git branches based on GitHub issues. It fetches issues using GitHub CLI, presents them in an interactive autocomplete interface with colored labels, and automatically generates branch names following conventional patterns.

## Command Signature

```bash
# Create branch for assigned issues
towles-tool github-branch

# Create branch for all issues (not just assigned)
towles-tool github-branch --assigned-to-me=false
```

## Functional Requirements

### 1. Prerequisites
- **GitHub CLI Installation**: Verify `gh` CLI is installed and available
- **Authentication**: Assume GitHub CLI is properly authenticated
- **Git Repository**: Command must be run within a git repository
- **Exit on missing prerequisites**: Terminate with error if GitHub CLI is not available

### 2. Issue Fetching
- **Default behavior**: Fetch issues assigned to current user
- **Assignment filter**: `--assigned-to-me=false` flag to fetch all issues
- **Repository context**: Automatically detect current repository from git remote
- **Empty results handling**: Display warning and exit if no issues found

### 3. Interactive Issue Selection
- **Autocomplete interface**: Use prompts with autocomplete for issue selection
- **Fuzzy search**: Implement fuzzy finding using Fzf library for quick issue filtering
- **Search scope**: Search across issue number, title, and description
- **Case insensitive**: Support case-insensitive search
- **Cancel option**: Provide "Cancel" choice in selection list
- **Escape handling**: Support ESC key to cancel operation

### 4. Issue Display Formatting
- **Responsive layout**: Adapt to terminal width (max 130 columns)
- **Columnar format**: Display issue number, title, and labels in aligned columns
- **Label coloring**: Display GitHub labels with their original hex colors using ANSI 24-bit color
- **Text truncation**: Truncate long titles with ellipsis to fit terminal width
- **Visual alignment**: Pad columns for consistent visual presentation

### 5. Branch Name Generation
- **Naming convention**: `feature/{issue-number}-{slugified-title}`
- **Title slugification**: Convert issue title to URL-friendly slug
  - Convert to lowercase
  - Replace spaces with hyphens
  - Remove non-alphanumeric characters (except underscores and hyphens)
  - Collapse multiple consecutive hyphens
  - Remove trailing hyphens
- **Issue number prefix**: Always include issue number for traceability

### 6. Branch Creation
- **Git integration**: Create new branch using git wrapper utility
- **Success confirmation**: Display selected issue and generated branch name
- **Automatic checkout**: Switch to newly created branch after creation

### 7. Error Handling
- **GitHub CLI errors**: Handle authentication, network, and API errors gracefully
- **Git errors**: Handle branch creation failures (e.g., branch already exists)
- **User cancellation**: Allow cancellation at any prompt stage
- **Empty issue lists**: Provide clear messaging when no issues are available
- **Process termination**: Use appropriate exit codes for different error scenarios

## Technical Implementation

### File Location
- **Command file**: `src/commands/github-branch-command.ts`
- **CLI registration**: `src/index.ts` (command: `github-branch`)

## User Experience Flow

1. **Prerequisite Check**: Verify GitHub CLI installation
2. **Issue Fetching**: Retrieve issues based on assignment filter
3. **Issue Display**: Show formatted issue list with colored labels
4. **Interactive Selection**: Present autocomplete interface with fuzzy search
5. **Branch Name Generation**: Create branch name from selected issue
6. **Branch Creation**: Create and checkout new git branch
7. **Confirmation**: Display success message with branch details

### Environment Dependencies
- GitHub CLI (`gh`) must be installed and authenticated
- Current directory must be within a git repository
- Terminal must support ANSI color codes for optimal label display

## Edge Cases

- **No issues found**: Display appropriate message and exit gracefully
- **Long issue titles**: Truncate with ellipsis to fit terminal width
- **Missing label colors**: Handle labels without color information
- **Branch name conflicts**: Handle cases where generated branch name already exists
- **Network connectivity**: Handle GitHub API connectivity issues
- **Repository detection**: Handle cases where git remote is not GitHub

## Future Enhancements

- Support for different branch prefixes (feat/, fix/, chore/)
- Integration with issue assignment workflow
- Branch template customization
- Support for draft pull request creation
- Issue filtering by labels or milestones