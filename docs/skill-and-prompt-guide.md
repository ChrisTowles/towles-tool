# Skill & Prompt Engineering Guide

Rules extracted from the actual text of [Anthropic's Complete Guide to Building Skills for Claude][anthropic] and [Simon Willison's Agentic Engineering Patterns][willison].

---

## Part 1: Fundamentals

> [Anthropic Guide][anthropic] — Ch. 1

### 1.1 What is a Skill?

A folder containing:

- **SKILL.md** (required): Instructions in Markdown with YAML frontmatter
- **scripts/** (optional): Executable code (Python, Bash, etc.)
- **references/** (optional): Documentation loaded as needed
- **assets/** (optional): Templates, fonts, icons used in output

### 1.2 Progressive Disclosure

Skills use a three-level system:

| Level                    | What                                                                                             | When Loaded |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ----------- |
| **L1: YAML frontmatter** | Always loaded in system prompt. Provides just enough for Claude to know _when_ to use the skill. | Always      |
| **L2: SKILL.md body**    | Loaded when Claude thinks the skill is relevant. Contains full instructions.                     | On trigger  |
| **L3: Linked files**     | Additional files bundled in the skill directory that Claude discovers only as needed.            | On demand   |

> "This progressive disclosure minimizes token usage while maintaining specialized expertise."

### 1.3 Composability

Claude can load multiple skills simultaneously. Your skill should work well alongside others, not assume it's the only capability available.

### 1.4 Portability

Skills work identically across Claude.ai, Claude Code, and API. Create once, works everywhere — provided the environment supports any dependencies.

---

## Part 2: Planning and Design

> [Anthropic Guide][anthropic] — Ch. 2

### 2.1 Start with Use Cases

Before writing any code, identify 2-3 concrete use cases. Good use case definition:

- Trigger condition (what the user says)
- Multi-step workflow breakdown
- Required tools (built-in or MCP)
- Domain knowledge to embed
- Expected result

### 2.2 Three Use Case Categories

| Category                      | Purpose                                                        | Key Techniques                                                                           |
| ----------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Document & Asset Creation** | Creating consistent, high-quality output (docs, designs, code) | Embedded style guides, template structures, quality checklists, no external tools needed |
| **Workflow Automation**       | Multi-step processes with consistent methodology               | Step-by-step workflow with validation gates, templates, iterative refinement loops       |
| **MCP Enhancement**           | Workflow guidance on top of MCP tool access                    | Coordinates multiple MCP calls, embeds domain expertise, error handling for MCP issues   |

### 2.3 Success Criteria

> "These are aspirational targets — rough benchmarks rather than precise thresholds."

**Quantitative:**

- Skill triggers on 90% of relevant queries (test with 10-20 queries)
- Completes workflow in X tool calls (compare with/without skill)
- 0 failed API calls per workflow (monitor MCP server logs)

**Qualitative:**

- Users don't need to prompt Claude about next steps
- Workflows complete without user correction (run 3-5 times, compare consistency)
- Consistent results across sessions (can a new user succeed on first try?)

### 2.4 Technical Requirements

**Critical rules:**

| Rule            | Detail                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| SKILL.md naming | Must be exactly `SKILL.md` (case-sensitive). No variations.                                    |
| Folder naming   | kebab-case only: `notion-project-setup` . No spaces, underscores, or capitals.                 |
| No README.md    | Don't include README.md inside skill folder. All docs go in SKILL.md or `references/`.         |
| Security        | No XML angle brackets (`<` `>`) anywhere. No "claude" or "anthropic" in skill name (reserved). |

**YAML frontmatter — required fields:**

```yaml
---
name: skill-name-in-kebab-case
description: What it does and when to use it. Include specific trigger phrases.
---
```

**Optional fields:**

```yaml
license: MIT
allowed-tools: "Bash(python:*) Bash(npm:*) WebFetch" # Restrict tool access
compatibility: "Requires network access" # 1-500 chars
metadata:
  author: Company Name
  version: 1.0.0
  mcp-server: server-name
```

### 2.5 The Description Field

> "This metadata...provides just enough information for Claude to know when each skill should be used without loading all of it into context."

**Structure:** `[What it does]` + `[When to use it]` + `[Key capabilities]`

**Good:**

```yaml
# Specific and actionable
description: Analyzes Figma design files and generates developer handoff
  documentation. Use when user uploads .fig files, asks for "design specs",
  "component documentation", or "design-to-code handoff".

# Includes trigger phrases
description: Manages Linear project workflows including sprint planning,
  task creation, and status tracking. Use when user mentions "sprint",
  "Linear tasks", "project planning", or asks to "create tickets".

# Clear value proposition
description: End-to-end customer onboarding workflow for PayFlow. Handles
  account creation, payment setup, and subscription management. Use when
  user says "onboard new customer", "set up subscription", or "create
  PayFlow account".
```

**Bad:**

```yaml
description: Helps with projects.  # Too vague
description: Creates sophisticated multi-page documentation systems.  # Missing triggers
description: Implements the Project entity model with hierarchical relationships.  # Too technical
```

### 2.6 Writing Instructions

Recommended structure:

```markdown
---
name: your-skill
description: [...]
---

# Your Skill Name

## Instructions

### Step 1: [First Major Step]

Clear explanation of what happens.
Expected output: [describe what success looks like]

### Step 2: [Next Step]

...

## Examples

### Example 1: [common scenario]

User says: "Set up a new marketing campaign"
Actions:

1. Fetch existing campaigns via MCP
2. Create new campaign with provided parameters
   Result: Campaign created with confirmation link

## Troubleshooting

### Error: [Common error message]

Cause: [Why it happens]
Solution: [How to fix]
```

### 2.7 Best Practices for Instructions

**Be specific and actionable:**

```markdown
# Good

Run `python scripts/validate.py --input {filename}` to check data format.
If validation fails, common issues include:

- Missing required fields (add them to the CSV)
- Invalid date formats (use YYYY-MM-DD)

# Bad

Validate the data before proceeding.
```

**Reference bundled resources clearly:**

```markdown
Before writing queries, consult `references/api-patterns.md` for:

- Rate limiting guidance
- Pagination patterns
- Error codes and handling
```

**Use progressive disclosure:** Keep SKILL.md focused on core instructions. Move detailed documentation to `references/` and link to it.

**Include error handling:**

```markdown
## Common Issues

### MCP Connection Failed

If you see "Connection refused":

1. Verify MCP server is running: Check Settings > Extensions
2. Confirm API key is valid
3. Try reconnecting: Settings > Extensions > [Your Service] > Reconnect
```

---

## Part 3: Testing and Iteration

> [Anthropic Guide][anthropic] — Ch. 3

### 3.1 Pro Tip: Iterate on a Single Task First

> "Iterate on a single challenging task until Claude succeeds, then extract the winning approach into a skill. This leverages Claude's in-context learning and provides faster signal than broad testing."

### 3.2 Trigger Testing

**Goal:** Ensure skill loads at the right times.

```
Should trigger:
- "Help me set up a new ProjectHub workspace"
- "I need to create a project in ProjectHub"
- "Initialize a ProjectHub project for Q4 planning"

Should NOT trigger:
- "What's the weather in San Francisco?"
- "Help me write Python code"
- "Create a spreadsheet"
```

### 3.3 Functional Testing

**Goal:** Verify the skill produces correct outputs.

```
Test: Create project with 5 tasks
Given: Project name "Q4 Planning", 5 task descriptions
When: Skill executes workflow
Then:
  - Project created in ProjectHub
  - 5 tasks created with correct properties
  - All tasks linked to project
  - No API errors
```

### 3.4 Performance Comparison

**Goal:** Prove the skill improves results vs. baseline.

|     | Without Skill                        | With Skill                   |
| --- | ------------------------------------ | ---------------------------- |
|     | User provides instructions each time | Automatic workflow execution |
|     | 15 back-and-forth messages           | 2 clarifying questions only  |
|     | 3 failed API calls requiring retry   | 0 failed API calls           |
|     | 12,000 tokens consumed               | 6,000 tokens consumed        |

### 3.5 Iteration Based on Feedback

**Undertriggering** (skill doesn't load when it should):
→ Add more detail and nuance to description, especially technical keywords

**Overtriggering** (skill loads for irrelevant queries):
→ Add negative triggers, be more specific

**Execution issues** (inconsistent results, API failures, user corrections needed):
→ Improve instructions, add error handling

### 3.6 Using the skill-creator Skill

Available in Claude.ai and Claude Code. If you have an MCP server and know your top 2-3 workflows, you can build and test a functional skill in 15-30 minutes.

**Creating skills:** Generate from natural language, produce properly formatted SKILL.md, suggest trigger phrases.
**Reviewing skills:** Flag common issues, identify over/under-triggering risks, suggest test cases.

---

## Part 4: Patterns and Troubleshooting

> [Anthropic Guide][anthropic] — Ch. 5

### 4.1 Problem-First vs Tool-First

- **Problem-first:** "I need to set up a project workspace" → Skill orchestrates the right MCP calls in sequence. Users describe outcomes; skill handles tools.
- **Tool-first:** "I have Notion MCP connected" → Skill teaches Claude optimal workflows. Users have access; skill provides expertise.

### 4.2 Pattern: Sequential Workflow Orchestration

Use when users need multi-step processes in specific order. Key techniques: explicit step ordering, dependencies between steps, validation at each stage, rollback instructions for failures.

### 4.3 Pattern: Multi-MCP Coordination

Use when workflows span multiple services. Key techniques: clear phase separation, data passing between MCPs, validation before moving to next phase, centralized error handling.

### 4.4 Pattern: Iterative Refinement

Use when output quality improves with iteration. Key techniques: explicit quality criteria, validation scripts, know when to stop iterating.

### 4.5 Pattern: Context-Aware Tool Selection

Use when same outcome needs different tools depending on context. Key techniques: clear decision criteria, fallback options, transparency about choices.

### 4.6 Pattern: Domain-Specific Intelligence

Use when skill adds specialized knowledge beyond tool access. Key techniques: domain expertise embedded in logic, compliance before action, comprehensive documentation, clear governance.

### 4.7 Troubleshooting: Instructions Not Followed

1. **Instructions too verbose** — Keep concise, use bullet points, move detail to separate files
2. **Instructions buried** — Put critical instructions at top, use `## Important` headers, repeat key points
3. **Ambiguous language:**

   ```markdown
   # Bad

   Make sure to validate things properly

   # Good

   CRITICAL: Before calling create_project, verify:

   - Project name is non-empty
   - At least one team member assigned
   - Start date is not in the past
   ```

4. **Use scripts for critical validations:**

   > "For critical validations, consider bundling a script that performs the checks programmatically rather than relying on language instructions. **Code is deterministic; language interpretation isn't.**"

5. **Model laziness** — Add explicit encouragement:
   ```markdown
   ## Performance Notes

   - Take your time to do this thoroughly
   - Quality is more important than speed
   - Do not skip validation steps
   ```
   > Note: "Adding this to user prompts is more effective than in SKILL.md"

### 4.8 Troubleshooting: Large Context Issues

- Keep SKILL.md under 5,000 words
- Move detailed docs to `references/`
- Limit to 20-50 skills enabled simultaneously
- Consider skill "packs" for related capabilities

---

## Part 5: Skill Checklist

> [Anthropic Guide][anthropic] — Reference A

### Before You Start

- [ ] Identified 2-3 concrete use cases
- [ ] Tools identified (built-in or MCP)
- [ ] Reviewed guide and example skills
- [ ] Planned folder structure

### During Development

- [ ] Folder named in kebab-case
- [ ] SKILL.md file exists (exact spelling)
- [ ] YAML frontmatter has `---` delimiters
- [ ] name: kebab-case, no spaces, no capitals
- [ ] description includes WHAT and WHEN
- [ ] No XML tags (`<` `>`) anywhere
- [ ] Instructions are clear and actionable
- [ ] Error handling included
- [ ] Examples provided
- [ ] References clearly linked

### Before Upload

- [ ] Tested triggering on obvious tasks
- [ ] Tested triggering on paraphrased requests
- [ ] Verified doesn't trigger on unrelated topics
- [ ] Functional tests pass
- [ ] Tool integration works (if applicable)

### After Upload

- [ ] Test in real conversations
- [ ] Monitor for under/over-triggering
- [ ] Collect user feedback
- [ ] Iterate on description and instructions
- [ ] Update version in metadata

---

## Part 6: Red/Green TDD — The Agent's Reward Function

> [Simon Willison][willison] — Agentic Engineering Patterns

### 6.1 Why This Is the Most Important Pattern

AI agents have no built-in way to know if their code works. They generate text that _looks_ correct but have no feedback signal. **Tests are the agent's reward function** — the only objective, automated mechanism for an agent to validate it's making progress and producing working code.

Without tests, an agent is flying blind:

- It writes code that _appears_ right but may not run
- It has no way to know if a change broke something else
- It can't distinguish "done" from "looks done"
- It drifts further from correctness with each step

With red/green TDD, every step produces a measurable signal: red → green = progress. The agent can self-correct, retry, and iterate toward working code with confidence.

### 6.2 The Core Pattern

"Red/green TDD" is shorthand for: **write tests first, confirm they fail (red), then implement code to make them pass (green).** Every major LLM understands this phrase as a complete instruction.

The three phases:

1. **Red** — Write tests that define the expected behavior. Run them. **Watch them fail.** This proves the test is actually testing something new.
2. **Green** — Implement the minimum code to make tests pass. The passing test is the agent's confirmation that the implementation works.
3. **Verify** — Run the full suite. No regressions = safe to move to the next task.

### 6.3 Tests as Feedback Loop

Think of it as a closed-loop control system:

```
Define behavior (test) → Measure (run test, expect red)
    → Act (implement) → Measure again (run test, expect green)
        → Confirm no regressions (full suite) → Next task
```

Each red→green cycle gives the agent:

- **Clarity** — the test defines exactly what "done" means
- **Validation** — passing tests prove the code works, not just compiles
- **Guardrails** — the full suite catches unintended side effects
- **Progress signal** — each green test is measurable forward motion

Without this loop, agents tend to write large chunks of untested code that _seem_ complete but collapse when actually executed.

### 6.4 The Critical Step Most Skip

**Confirming test failure before implementing is non-negotiable.** If you skip the red phase, you risk:

- Tests that already pass (testing nothing new)
- Tests that pass for the wrong reasons
- False confidence — the "reward signal" is meaningless if it was green from the start

The red phase calibrates the feedback loop. It proves the test is actually measuring the new behavior.

### 6.5 How to Use It

**Simple prompt:** Add "Use red/green TDD." to any implementation request.

```
Build a function to extract headers from a markdown string. Use red/green TDD.
```

**In a pipeline or checklist:** Make each task a self-contained red→green cycle:

```markdown
For each task:

1. Write tests that define the expected behavior
2. Run tests — confirm they fail (red)
3. Implement the change
4. Run tests — confirm they pass (green)
5. Run full test suite — confirm no regressions
6. Mark task complete and commit
```

This gives the agent a clear reward signal at every step, not just at the end.

### 6.6 When to Apply

| Scenario               | Use Red/Green TDD? | Why                                                                                       |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| New function or module | **Always**         | Define behavior through tests first                                                       |
| Bug fix                | **Always**         | Write a test that reproduces the bug — red proves the bug exists, green proves it's fixed |
| Refactoring            | **Yes**            | Existing tests are the safety net; add missing ones before changing code                  |
| Config/wiring changes  | No                 | Hard to unit test; verify manually or with integration tests                              |
| UI/visual changes      | No                 | Use screenshot comparison instead                                                         |

### 6.7 Rules for Agent TDD

1. **Always watch tests fail first** — never skip the red phase; it calibrates the reward signal
2. **One behavior per test** — small, focused assertions give precise feedback on what broke
3. **Run the full suite after each green** — catch regressions immediately, not at the end
4. **Test behavior and outputs, not implementation details** — tests should survive refactoring
5. **Keep tests fast** — agents run them many times per task; slow tests kill the feedback loop
6. **Commit after each green cycle** — creates save points the agent (or human) can roll back to

---

## Sources

- [The Complete Guide to Building Skills for Claude (Anthropic)](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf?hsLang=en)
- [Agentic Engineering Patterns: Red/Green TDD (Simon Willison)](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/)
- [Anthropic Skills GitHub](https://github.com/anthropics/skills)

[anthropic]: https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf?hsLang=en
[willison]: https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/
