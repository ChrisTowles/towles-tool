# Evalite Evaluations

This directory contains evaluation tests for AI-powered features in towles-tool, using [Evalite](https://www.evalite.dev/) - a TypeScript-native LLM evaluation framework.

## Setup

Dependencies are already installed. To rebuild better-sqlite3 if needed:

```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
npm run build-release
```

## Running Evaluations

### Watch Mode (Development)
```bash
pnpm run eval:dev
```

This starts Evalite in watch mode with a UI at http://localhost:3006

### Run Once
```bash
pnpm run eval
```

## Current Evaluations

### `ai-workflow.eval.ts`

Evaluates the `/tt:ai` autonomous AI assistant command defined in `plugins/tt-core/commands/ai.md`.

**Test Suites:**

1. **AI Workflow - Basic Goal Completion**
   - Tests decision-making for different task types
   - Evaluates when to use TodoWrite
   - Checks when to ask clarifying questions
   - Validates code generation decisions

2. **AI Workflow - Autonomous Loop Behavior**
   - Tests the "continue autonomously" vs "ask user" decision logic
   - Validates option presentation (2-5 options when stuck)
   - Checks confirmation requests for risky operations

**Note:** Current implementation uses mock data. Future work should integrate actual Claude API calls to test real AI behavior.

## Writing New Evals

Create files with `.eval.ts` extension in this directory:

```typescript
import { evalite } from "evalite";
import { Factuality } from "autoevals";

evalite("My Eval Name", {
  data: [
    {
      input: "test input",
      expected: "expected output",
    },
  ],
  task: async (input) => {
    // Your task logic here
    return result;
  },
  scorers: [Factuality],
});
```

## Available Scorers

From [autoevals](https://github.com/braintrustdata/autoevals):

- `Levenshtein` - String similarity
- `Factuality` - LLM-as-judge for factual correctness
- Custom scorers via `createScorer`

## CI/CD Integration

Evals can be exported as static HTML for CI pipelines:

```bash
pnpm run eval --export
```

Configure score thresholds to gate builds in CI.

## References

- [Evalite Documentation](https://www.evalite.dev/)
- [Evalite GitHub](https://github.com/mattpocock/evalite)
- [Autoevals Documentation](https://www.braintrust.dev/docs/reference/autoevals)
