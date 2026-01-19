---
title: refactor-claude
description: Analyzes CLAUDE.md files, identifies contradictions, extracts essentials, and reorganizes into a progressive disclosure structure. Use when agent instructions are too long or disorganized.
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Task(*)
---

# Refactor CLAUDE.md for Progressive Disclosure

Copy this checklist and track progress:

```
- [ ] Step 1: Read all CLAUDE.md/AGENTS.md files
- [ ] Step 2: Identify contradictions
- [ ] Step 3: Extract essentials
- [ ] Step 4:Group into categories
- [ ] Step 5: Create file structure
- [ ] Step 6: Flag deletions
- [ ] Step 7: Get user approval
```

## Workflow

### 1. Find Contradictions
Identify instructions that conflict with each other. For each contradiction, ask the user which version to keep.

### 2. Extract Essentials
Pull only what belongs in the root AGENTS.md:
- One-sentence project description
- Package manager (if not npm)
- Non-standard build/typecheck commands
- Anything truly relevant to every single task

### 3. Group the Rest
Organize remaining instructions into logical categories.

**Common categories:**
- TypeScript/language conventions
- Testing patterns
- Git/PR workflow
- API design
- Error handling
- Logging/observability
- Security guidelines
- Performance considerations

### 4. Create File Structure
Output:
- A minimal root CLAUDE.md with markdown links to separate files
- Each separate file with its relevant instructions stored where it belongs, API or db information with 
- A suggested docs/ folder structure

### 5. Flag for Deletion
Identify instructions that are:
- Redundant (Claude already knows this)
- Too vague to be actionable
- Overly obvious (like "write clean code")

## AGENTS.md Template

```markdown
# Project Name

One-sentence description.

## Quick Reference
- Package manager: pnpm
- Build: `pnpm build`
- Test: `pnpm test`

## Guidelines
- [TypeScript conventions](docs/typescript.md)
- [Testing patterns](docs/testing.md)
- [Git workflow](docs/git-workflow.md)
```

## Example Output

**Before** (monolithic CLAUDE.md):
- 200 lines mixing project info, TypeScript rules, testing, git workflow...

**After**:
```
AGENTS.md              (15 lines) - project summary + links
docs/
  typescript.md        - TS conventions
  testing.md           - test patterns
  git-workflow.md      - commit/PR rules
```

## When NOT to Split
- Project has <50 lines of instructions
- Instructions are already well-organized
- Only one domain (e.g., pure TypeScript, no testing/git guidance)

In these cases, suggest improvements without creating multiple files.
