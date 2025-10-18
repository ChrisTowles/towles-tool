---
#allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), AskUserQuestion(*)
description: Create git commit 
---

## Context

- Current git status: !`git status`
- Current git diff (staged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

1. generate 5 single commit messages with conventional commits
2. **Use AskUserQuestion tool** to chose which of those, or their own to use.
3. Then create a single git commit with it, also staging any changes if they agreed to that.