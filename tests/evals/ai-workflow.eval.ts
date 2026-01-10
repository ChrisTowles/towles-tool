import { evalite } from "evalite";

/**
 * Evaluation for the AI workflow command (/tt:ai)
 *
 * This eval tests the autonomous AI assistant's ability to:
 * - Follow the goal-oriented workflow
 * - Make appropriate autonomous decisions
 * - Use TodoWrite effectively
 * - Ask questions at the right time
 */

evalite("AI Workflow - Basic Goal Completion", {
  data: [
    {
      input: "create a simple hello world function in TypeScript",
      expected: {
        shouldCreateTodo: false, // Simple task, no todo needed
        shouldAskQuestion: false, // Clear requirements, no questions needed
        shouldContainCode: true,
        shouldRunTests: false, // No test file exists
      },
    },
    {
      input: "fix test errors in the user authentication module",
      expected: {
        shouldCreateTodo: true, // Multi-step process
        shouldAskQuestion: false, // Can run tests to see errors first
        shouldRunTests: true,
      },
    },
    {
      input: "add a new payment provider - should we use Stripe or PayPal?",
      expected: {
        shouldCreateTodo: true, // Complex feature
        shouldAskQuestion: true, // Multiple valid approaches
        shouldContainCode: false, // Should ask before implementing
      },
    },
  ],
  task: async (input) => {
    // This is a placeholder for the actual AI workflow execution
    // In a real implementation, we would:
    // 1. Instantiate the AI assistant with the goal
    // 2. Let it run through its decision loop
    // 3. Capture its actions and outputs

    // For now, we'll return a mock response
    return {
      goal: input,
      actions: [],
      usedTodoWrite: false,
      askedQuestion: false,
      containsCode: false,
      ranTests: false,
    };
  },
  scorers: [
    {
      name: "Workflow Decision Quality",
      scorer: ({ input, output, expected }) => {
        let score = 0;
        let maxScore = 0;
        const feedback: string[] = [];

        // Check TodoWrite usage
        maxScore += 1;
        if (output.usedTodoWrite === expected.shouldCreateTodo) {
          score += 1;
        } else if (expected.shouldCreateTodo && !output.usedTodoWrite) {
          feedback.push("Should have used TodoWrite for multi-step task");
        } else if (!expected.shouldCreateTodo && output.usedTodoWrite) {
          feedback.push("TodoWrite not needed for simple task");
        }

        // Check question asking behavior
        maxScore += 1;
        if (output.askedQuestion === expected.shouldAskQuestion) {
          score += 1;
        } else if (expected.shouldAskQuestion && !output.askedQuestion) {
          feedback.push("Should have asked for clarification on ambiguous requirements");
        } else if (!expected.shouldAskQuestion && output.askedQuestion) {
          feedback.push("Requirements were clear, no question needed");
        }

        // Check code generation
        if (expected.shouldContainCode !== undefined) {
          maxScore += 1;
          if (output.containsCode === expected.shouldContainCode) {
            score += 1;
          } else if (expected.shouldContainCode && !output.containsCode) {
            feedback.push("Should have generated code");
          } else if (!expected.shouldContainCode && output.containsCode) {
            feedback.push("Should have asked before implementing");
          }
        }

        // Check test execution
        if (expected.shouldRunTests !== undefined) {
          maxScore += 1;
          if (output.ranTests === expected.shouldRunTests) {
            score += 1;
          } else if (expected.shouldRunTests && !output.ranTests) {
            feedback.push("Should have run tests to validate changes");
          }
        }

        return {
          score: score / maxScore,
          metadata: {
            feedback: feedback.length > 0 ? feedback.join("; ") : "All decisions aligned with expectations",
            scoreBreakdown: `${score}/${maxScore}`,
          },
        };
      },
    },
  ],
});

evalite("AI Workflow - Autonomous Loop Behavior", {
  data: [
    {
      input: "Tests pass after implementation",
      testsPassed: true,
      nextStepClear: true,
      isLowRisk: true,
      expected: {
        shouldContinueAutonomously: true,
        shouldAskQuestion: false,
      },
    },
    {
      input: "Tests fail with error",
      testsPassed: false,
      nextStepClear: false,
      isLowRisk: true,
      expected: {
        shouldContinueAutonomously: false,
        shouldAskQuestion: true,
        shouldPresentOptions: true,
        optionCount: { min: 2, max: 5 },
      },
    },
    {
      input: "Risky destructive operation needed",
      testsPassed: true,
      nextStepClear: true,
      isLowRisk: false,
      expected: {
        shouldContinueAutonomously: false,
        shouldAskQuestion: true,
        shouldGetConfirmation: true,
      },
    },
  ],
  task: async (input) => {
    // Mock the decision-making logic
    return {
      scenario: input,
      continuedAutonomously: false,
      askedQuestion: false,
      presentedOptions: false,
      optionCount: 0,
      gotConfirmation: false,
    };
  },
  scorers: [
    {
      name: "Autonomous Decision-Making",
      scorer: ({ input, output, expected }) => {
        let score = 0;
        let maxScore = 2;
        const feedback: string[] = [];

        // Check autonomous continuation decision
        if (output.continuedAutonomously === expected.shouldContinueAutonomously) {
          score += 1;
          if (expected.shouldContinueAutonomously) {
            feedback.push("✓ Correctly continued autonomously");
          } else {
            feedback.push("✓ Correctly paused for user input");
          }
        } else if (expected.shouldContinueAutonomously && !output.continuedAutonomously) {
          feedback.push("✗ Should have continued autonomously (all conditions met)");
        } else {
          feedback.push("✗ Should have paused for user input");
        }

        // Check question asking
        if (output.askedQuestion === expected.shouldAskQuestion) {
          score += 1;
        } else if (expected.shouldAskQuestion && !output.askedQuestion) {
          feedback.push("✗ Should have asked for guidance");
        }

        // Check option presentation
        if (expected.shouldPresentOptions && output.presentedOptions) {
          const optionCount = output.optionCount;
          const { min, max } = expected.optionCount || { min: 2, max: 5 };
          if (optionCount >= min && optionCount <= max) {
            feedback.push(`✓ Presented ${optionCount} actionable options`);
          } else {
            feedback.push(`✗ Presented ${optionCount} options (expected ${min}-${max})`);
          }
        }

        return {
          score: score / maxScore,
          metadata: {
            feedback: feedback.join("; "),
            scenario: input.scenario,
          },
        };
      },
    },
  ],
});
