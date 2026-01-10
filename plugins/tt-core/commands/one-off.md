---
#allowed-tools: Bash(mkdir:*), Bash(code:*), Bash(code-insiders:*), Write(*), Read(*)
description: Create a new one-off project folder for isolated tasks and experiments
argument-hint: title for the one-off (e.g., 'fix login bug' or 'spike redis caching')
---

## Context

**Title:** $ARGUMENTS
**Current date:** !`date +"%Y-%m-%d"`
**Current time:** !`date +"%H:%M"`

## Your Task

Create a one-off project folder for: **$ARGUMENTS**

### 1. Generate folder path

Use this pattern:
```
one-offs/{year}/{year-month-day}-{slug}/
```

- **year**: Current year (e.g., `2025`)
- **year-month-day**: Today's date (e.g., `2025-12-05`)
- **slug**: Title converted to kebab-case, lowercase, no special chars

Example: `one-offs/2025/2025-12-05-fix-login-bug/`

### 2. Create the folder

```bash
mkdir -p one-offs/{year}/{year-month-day}-{slug}
```

### 3. Create README.md

Write a README.md in the new folder with this template:

```markdown
# {Title}

**Created:** {date} {time}
**Status:** in-progress

## Goal

{Describe the goal based on the title - make it actionable}

## Context / Reasoning Chain

{What led to this task? Leave as prompts for user to fill in}

-
-

## Notes

## Outcome

{To be filled when complete}
```

### 4. Open in editor

```bash
code one-offs/{year}/{year-month-day}-{slug}
```

### 5. Confirm

Tell the user the folder was created and is ready for use.
