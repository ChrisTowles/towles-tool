# Code Reviewer Agent

Expert code review subagent for the towles-tool repository.

## Overview

The code-reviewer agent is a specialized Claude Code subagent that provides expert code review focused on towles-tool's architecture, conventions, and best practices.

## Location

`.claude/agents/code-reviewer.md`

## Usage

### Automatic Invocation

Claude Code will automatically invoke the code-reviewer agent when you:
- Request a code review
- Ask for feedback on changes
- Mention reviewing code quality

### Explicit Invocation

```
Use the code-reviewer agent to review the latest changes
```

```
Ask the code-reviewer to check the MCP tool implementation
```

## What It Reviews

### 1. Architecture & Design
- Module organization and separation of concerns
- CLI vs business logic separation
- MCP server integration patterns
- Dual CLI/MCP distribution compatibility

### 2. Code Quality
- TypeScript usage and type safety
- Error handling patterns (neverthrow, throws)
- Async/await consistency
- Parameter destructuring
- Naming conventions

### 3. Testing
- Test file co-location (`.test.ts`)
- Test coverage (success + error cases)
- Proper mocking with `vi.mocked()`
- Test clarity and focus

### 4. Project Standards
- Tech stack alignment (Vitest, Zod, consola, yargs, unbuild)
- Linting compliance (oxlint)
- Documentation updates
- Git hook compatibility

### 5. MCP-Specific
- Tool handler registration patterns
- JSON response structure with `success` field
- Type conversion patterns (`as unknown as`)
- Error response format
- Console statement linting compliance

## Review Format

The agent provides structured feedback:

### ✅ Strengths
What was done well and good practices observed

### 🔍 Issues Found
- **Severity**: Critical / Important / Minor / Suggestion
- **File:Line**: Specific location
- **Issue**: Clear description
- **Recommendation**: Specific fix

### 📝 Additional Notes
Architectural observations and future suggestions

## Example Usage

### Review Recent Changes

```
Can you review the changes I just made?
```

The agent will:
1. Read the changed files
2. Check for tests
3. Verify adherence to conventions
4. Assess impact on CLI and MCP
5. Provide structured feedback

### Review Specific Feature

```
Use the code-reviewer to review the new journal_list tool implementation
```

The agent will focus on:
- Implementation quality
- Test coverage
- MCP integration patterns
- Error handling
- Response format

### Pre-commit Review

```
Review my staged changes before I commit
```

The agent will:
- Check all staged files
- Verify tests exist
- Flag potential issues
- Confirm lint/typecheck readiness

## Agent Configuration

**Tools Available:**
- `Read` - Read source files
- `Grep` - Search codebase
- `Glob` - Find files by pattern

**Model:** Inherits from parent (Sonnet 4.5)

**Scope:** Project-level (`.claude/agents/`)

## Communication Style

- Expert to expert communication
- Clear, concise, actionable feedback
- Specific file:line references
- Constructive, not critical
- Acknowledges trade-offs

## Common Issues Flagged

- ❌ Missing tests for new features
- ❌ Hardcoded values (should be config)
- ❌ Missing error handling
- ❌ Inconsistent naming
- ❌ Breaking changes without migration
- ❌ Missing documentation
- ❌ CLI-only logic not shared

## Tips for Best Results

1. **Be Specific**: "Review the error handling in mcp/tools/journal.ts"
2. **Provide Context**: "Review this for production readiness"
3. **Ask Questions**: "Is there a better pattern for this?"
4. **Iterate**: Address feedback and ask for re-review

## Integration with Workflow

### During Development
```
Review my work so far on the journal_search feature
```

### Before Commit
```
Use code-reviewer to check these changes before I commit
```

### After Changes
```
Did I follow the project conventions correctly?
```

### Learning
```
What's the best practice for this pattern in towles-tool?
```

## Related

- [CLAUDE.md](../../CLAUDE.md) - Project conventions
- [MCP Integration](../mcp-setup.md) - MCP development guide
- [Testing Patterns](../../vitest.config.ts) - Test configuration

## Maintenance

The code-reviewer agent is version-controlled with the repository and automatically available to all contributors using Claude Code.

To modify:
1. Edit `.claude/agents/code-reviewer.md`
2. Update system prompt or tool permissions as needed
3. Commit changes to share with team
