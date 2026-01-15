---
title: improve_ralph
description: "Explore codebase and add improvements as ralph tasks"
allowed-tools: AskUserQuestion(*), Task(*), Bash(tt ralph:*), Read(*), Glob(*), Grep(*)
---

Explore codebase, identify improvements, add selected ones as ralph tasks.

## Phase 1: Generate Marker

Before exploring, generate a marker to link tasks to this research session:

```bash
tt ralph marker create
# Outputs: "RALPH_MARKER_{RANDOM}"
```

## Phase 2: Explore

Use Task agents (`subagent_type=Explore`) to analyze:

- Code quality (duplication, complexity, dead code)
- Architecture (coupling, separation of concerns)
- Performance (obvious bottlenecks, inefficiencies)
- Developer experience (missing tests, unclear patterns)
- Security (exposed secrets, unsafe patterns)

## Phase 3: Identify

Find 15-20 concrete improvement opportunities.

Each improvement must be:

- **Actionable** - Not a nitpick, something that can be implemented
- **Specific** - Names files, functions, patterns
- **High-impact** - Prioritize low-effort wins
- **Verifiable** - Has clear success criteria

## Phase 4: Present

Use `AskUserQuestion` with:

- **question**: "Which improvements should I add as ralph tasks?"
- **multiSelect**: true
- **options**: 15-20 specific improvements with brief descriptions

## Phase 5: Add Tasks

For each selected improvement, create a detailed ralph task:

```bash
tt ralph task add "[Detailed description with context and success criteria]" --findMarker "RALPH_MARKER_{RANDOM}"
```

Task descriptions should read like a half-page GitHub issue:

```bash
tt ralph task add "Remove duplicate validation logic in src/utils/

## Background
validateEmail() and validateUserEmail() do the same thing.

## Requirements
- Keep validateEmail() in src/utils/validation.ts
- Update all imports from validateUserEmail to validateEmail
- Delete validateUserEmail from src/utils/user.ts

## Files
- src/utils/validation.ts (keep)
- src/utils/user.ts (remove duplicate)
- src/services/auth.ts (update import)

## Success Criteria
- [ ] Single validation function
- [ ] All tests pass: pnpm test
- [ ] Types pass: pnpm typecheck" --findMarker "RALPH_MARKER_{RANDOM}"
```

## Phase 6: Instruct User

Show final task list:

```bash
tt ralph task list
```

Tell user that tasks are ready! Start autonomous execution:

```bash
tt ralph run --maxIterations 20
```

Or without auto-commits:

```bash
tt ralph run --no-autoCommit --maxIterations 20
```
