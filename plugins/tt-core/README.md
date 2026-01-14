# tt-core

Core workflow automation commands for Claude Code.

## Commands

### `/tt:commit` - AI-Powered Git Commits

Generate conventional commit messages with AI assistance.

**What it does:**

1. Analyzes current git status and changes
2. Generates 5 single-line commit message options
3. Prompts you to select one (or write your own)
4. Creates the commit with the selected message

**Usage:**

```
/tt:commit
```

The command automatically reviews staged and unstaged changes, recent commit history, and current branch context to generate contextually appropriate commit messages following conventional commits format.

### `/tt:refine` - Text Refinement

Improve grammar, spelling, and wording while maintaining conciseness and clarity.

**What it does:**

- Fixes spelling and grammar errors
- Improves sentence structure and flow
- Removes unnecessary words and redundancy
- Maintains professional semi-formal tone
- Preserves original meaning and intent

**Usage:**

```
/tt:refine @path/to/file.md
```

**Note:** Currently only works with file paths, not selected text in the editor.

## Installation

This plugin is part of the towles-tool project and can be installed via the Claude Code plugin marketplace.

## Author

Chris Towles
