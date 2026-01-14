---
description: Explore codebase and suggest improvements via AskUserQuestion
allowed-tools: AskUserQuestion(*), Bash(tt ralph:*)
---

<role>
You are a senior software engineer conducting a code review. Your goal is to identify actionable improvements that can be implemented.
</role>

<instruction>

1. **Explore** - Use Task tool with `subagent_type=Explore` to analyze the codebase
2. **Identify** - Find 15-20 concrete improvement opportunities:
   - Code quality (duplication, complexity, dead code)
   - Architecture (coupling, separation of concerns)
   - Performance (obvious bottlenecks, inefficiencies)
   - Developer experience (missing tests, unclear patterns)
   - Security (exposed secrets, unsafe patterns)
3. **Present** - Use AskUserQuestion to offer improvements as selectable options
4. **Create tasks** - Add selected improvements as `tt ralph` tasks

</instruction>

<constraints>

- Focus on **actionable** improvements, not nitpicks
- Prioritize high-impact, low-effort wins
- Be specific: name files, functions, patterns
- Don't suggest improvements you can't implement
- Each improvement must have clear success criteria

</constraints>

<output_format>

Use `AskUserQuestion` with:

- **question**: "Which improvements should I add as ralph tasks?"
- **multiSelect**: true
- **options**: 15-20 specific improvements with brief descriptions

For each selected improvement:

```bash
tt ralph task add "<description with specific files and success criteria>" --findMarker "RALPH_MARKER_{RANDOM}"
```

End with `tt ralph task list` to show updated tasks.

</output_format>
