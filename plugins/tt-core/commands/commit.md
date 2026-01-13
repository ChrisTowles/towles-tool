---
description: Create git commit
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git push:*), AskUserQuestion(*)
---

<context>
- Current git status: !`git status`
- Current git diff (staged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`
</context>

<instruction>
Generate commit message options and guide user through commit workflow.

1. Generate 5 **single line** commit messages using conventional commits format
2. Use **AskUserQuestion** to ask the following:
   1. Chosen commit message from options
   2. Whether to stage all changes or select files
   3. Whether to push after commit
   4. Whether to create a PR after push
3. Create commit with that message
4. If user wants to push, run `git push`
5. If user wants PR, provide `gh pr create --web` command
6. After commit, show success message with commit hash.
</instruction>

<constraints>
- Always use conventional commits format (feat:, fix:, chore:, etc.)
- Never commit without user selecting/confirming message
- Don't push without explicit permission
</constraints>

