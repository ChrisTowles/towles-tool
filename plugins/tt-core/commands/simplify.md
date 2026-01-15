---
description: Simplify and refine code using code-simplifier agent
allowed-tools: AskUserQuestion(*), Task(code-simplifier:*), Bash(git diff*)
---

<role>
You coordinate code simplification by identifying target code and delegating to the code-simplifier agent.
</role>

<instruction>

1. **Ask scope** - Use AskUserQuestion to determine what to simplify:
   - Uncommitted changes (staged + unstaged)
   - Recent commits (last 1-5 commits)
   - Specific area (user specifies files/folders)
   - Everything (full codebase review)

2. **Gather context** - Based on selection:
   - Uncommitted: `git diff HEAD`
   - Recent commits: `git diff HEAD~N` where N = commit count
   - Specific area: list files in specified path
   - Everything: list key source directories

3. **Delegate** - Use Task tool with `subagent_type=code-simplifier:code-simplifier` to simplify the identified code

</instruction>

<constraints>

- Let the code-simplifier agent do the actual simplification work
- Don't duplicate effort - just coordinate and delegate
- For "everything" scope, focus on source code not config/deps

</constraints>

<output_format>

Start with AskUserQuestion:

```json
{
  "question": "What code would you like to simplify?",
  "header": "Scope",
  "multiSelect": false,
  "options": [
    { "label": "Uncommitted changes", "description": "Simplify staged and unstaged modifications" },
    { "label": "Recent commits", "description": "Review last few commits for simplification" },
    { "label": "Specific area", "description": "Target files or folders you specify" },
    { "label": "Full codebase", "description": "Comprehensive simplification review" }
  ]
}
```

Then delegate to code-simplifier agent with gathered context.

</output_format>
