---
description: Transform a conversation or idea into a structured PRD with user stories
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Bash(git *)
---

Create a Product Requirements Document from the current conversation or a provided description.

$ARGUMENTS

## Process

1. **Gather context** — Read provided files, explore repo architecture (`Glob`, `Grep`). If context is thin, interview (3-5 questions via `AskUserQuestion`).
2. **Interview for gaps** — Ask about: target users, acceptance criteria, technical constraints, dependencies on existing code.
3. **Draft the PRD** using the template below.
4. **Present for review** — Show draft, ask for feedback via `AskUserQuestion`.
5. **Output** — Ask preference: save to `docs/plans/YYYY-MM-DD-<feature-name>.md` or create as GitHub issue.

## PRD Template

```markdown
# [Feature Name]

## Problem Statement
What problem does this solve? Who has this problem?

## Goals
- Goal 1
- Goal 2

## Non-Goals
- Explicitly out of scope

## User Stories
- As a [user], I want [action] so that [outcome]

## Technical Design
### Architecture
How this fits into the existing system.

### Data Model
New or modified data structures.

### API / Interface
Public-facing contracts.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Open Questions
- Anything unresolved
```

## Rules

- User stories are mandatory — every feature must map to at least one.
- Acceptance criteria must be testable (not "works well").
- Reference existing code paths when relevant.
- Keep it concise — PRD should be 1-3 pages, not a novel.
