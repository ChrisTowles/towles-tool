---
description: Analyze codebase architecture for agent-friendliness and structural quality, then suggest improvements
allowed-tools: AskUserQuestion(*), Read(*), Glob(*), Grep(*), Agent(*)
---

Analyze codebase architecture for agent-friendliness and structural quality. Diagnose first, present options — never start refactoring immediately.

$ARGUMENTS

## Process

### 1. Analyze

Diagnose from the user's description directly. Use `Agent` with `subagent_type=Explore` only when you need to examine actual files.

Anti-patterns to look for:

- **Scattered concepts** — features requiring many files to understand
- **Tight coupling** — modules that can't be tested/changed independently
- **Missing boundaries** — no clear interfaces between subsystems
- **Impure functions** — side effects mixed into business logic
- **God classes** — classes doing too much, imported everywhere
- **Circular dependencies** — modules importing each other
- **Inconsistent patterns** — mixed error handling, logging, data access
- **Test gaps** — untested critical paths
- **Large files** — >300 lines is a smell

If architecture is already clean, say so. Do not invent problems.

### 2. Diagnose

For each issue, classify:

- **Impact**: How much does this hurt comprehension and AI agent collaboration?
- **Effort**: small/medium/large
- **Risk**: What could break?

Prioritize high impact + low effort. Explain which fixes unlock further improvements.

### 3. Present

Present 5-15 specific improvements, each with:

- Concrete problem description
- Specific proposed fix
- Affected areas
- Effort estimate

No code snippets — describe changes in plain language. Use `AskUserQuestion` with multiSelect so the user can choose which to pursue.

### 4. Output

For selected improvements, ask preference: plan in `docs/plans/YYYY-MM-DD-architecture-improvements.md` or GitHub issues.

## Philosophy

> "If you have a garbage code base, the AI will produce garbage within that code base."

Focus on changes that help both humans and AI agents:

- Larger, self-contained modules over scattered files
- Thin interfaces between modules
- Pure functions extracted from side-effectful code
- Co-located tests
- Standardized patterns across the codebase
- Incremental migration over big-bang rewrites
