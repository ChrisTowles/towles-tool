## Testing

### Framework & Config

Uses [vitest](https://vitest.dev/) configured in `vitest.config.ts`. Tests are co-located with source as `*.test.ts` files.

### Running Tests

```bash
bun test               # Run all vitest tests
bun test:watch          # Watch mode (auto-skips API tests via CI=DisableCallingClaude)
bun test -- path        # Filter by path (e.g. bun test -- journal)
```

### Prompt Template Testing

Uses [promptfoo](https://promptfoo.dev/) to validate prompt templates render correctly. Echo provider renders without calling an LLM; LLM variant uses Anthropic API.

```bash
bun test:prompts                  # All echo prompt tests (root + plugins)
bun test:prompts:tt-core          # tt-core plugin prompt tests
bun test:prompts:tt-core:llm      # LLM-based eval (needs ANTHROPIC_API_KEY)
```

### Environment Variables

- `CI=DisableCallingClaude` — skips tests that call the Anthropic API. Set automatically in `test:watch`.

### Test Coverage

Test files cover:

- **Commands**: `config`, `graph`, `gh/branch`, `doctor`, `journal`
- **Utilities**: date-utils, branch-name, gh-cli-wrapper, render
- **Prompt templates**: promptfoo configs validate structure of plan/implement/simplify/review prompts and plugin command prompts
