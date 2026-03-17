## Testing

### Framework & Config

Uses [vitest](https://vitest.dev/) configured in `vitest.config.ts`. Tests are co-located with source as `*.test.ts` files.

### Running Tests

```bash
pnpm test               # Run all vitest tests
pnpm test:watch          # Watch mode (auto-skips API tests via CI=DisableCallingClaude)
pnpm test -- path        # Filter by path (e.g. pnpm test -- auto-claude)
```

### Prompt Template Testing

Uses [promptfoo](https://promptfoo.dev/) to validate prompt templates render correctly. Echo provider renders without calling an LLM; LLM variant uses Anthropic API.

```bash
pnpm test:prompts                  # All echo prompt tests (root + plugins)
pnpm test:prompts:root             # Root promptfoo config only (auto-claude templates)
pnpm test:prompts:tt-core          # tt-core plugin prompt tests
pnpm test:prompts:tt-core:llm      # LLM-based eval (needs ANTHROPIC_API_KEY)
pnpm test:prompts:tt-auto-claude   # tt-auto-claude plugin prompt tests
```

### Environment Variables

- `CI=DisableCallingClaude` — skips tests that call the Anthropic API. Set automatically in `test:watch`.

### Test Coverage

17 test files covering:

- **Commands**: `config`, `graph`, `gh/branch`, `auto-claude/retry`, `auto-claude/status`
- **Auto-claude lib**: pipeline, pipeline-execution, config, prompt-templates, run-claude, steps, utils, utils-execution
- **Utilities**: date-utils, branch-name, gh-cli-wrapper, render
- **Prompt templates**: promptfoo configs validate structure of plan/implement/simplify/review prompts and plugin command prompts
