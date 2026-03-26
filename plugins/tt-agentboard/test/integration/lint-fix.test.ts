import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const tmpDirs: string[] = [];

// Resolve oxlint binary from project node_modules
const OXLINT_BIN = resolve(__dirname, "../../../../node_modules/.bin/oxlint");

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-fix-test-"));
  tmpDirs.push(dir);
  return dir;
}

function isClaudeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Lint Fix Integration", { timeout: 90_000 }, () => {
  it("agent finds and fixes a console.log lint violation", async ({ skip }) => {
    if (!isClaudeAvailable()) skip();
    if (!existsSync(OXLINT_BIN)) skip();

    const dir = makeTmpDir();

    // Initialize a git repo
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });

    // Write a TS file with a console.log violation
    writeFileSync(
      join(dir, "app.ts"),
      `export function greet(name: string): string {
  console.log("greeting:", name);
  return \`Hello, \${name}!\`;
}
`,
    );

    // Write an oxlint config that forbids console.log (must be .oxlintrc.json)
    writeFileSync(
      join(dir, ".oxlintrc.json"),
      JSON.stringify(
        {
          rules: {
            "no-console": "error",
          },
        },
        null,
        2,
      ) + "\n",
    );

    // Initial commit so git diff works
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: dir, stdio: "ignore" });

    // Verify lint fails before agent runs
    let lintFailed = false;
    try {
      execSync(`${OXLINT_BIN} .`, { cwd: dir, stdio: "pipe" });
    } catch {
      lintFailed = true;
    }
    expect(lintFailed).toBe(true);

    // Symlink oxlint into the temp dir so the agent can find it
    execSync(`ln -s ${OXLINT_BIN} ${join(dir, "oxlint")}`, { stdio: "ignore" });

    // Run claude to fix lint errors
    const prompt =
      "Run ./oxlint . to find lint errors. Fix the errors in app.ts by removing the console.log call. Then run ./oxlint . again to verify it passes. Commit the fix.";
    execSync(`claude --model haiku -p "${prompt}" --max-turns 8 --dangerously-skip-permissions`, {
      cwd: dir,
      stdio: "ignore",
      timeout: 80_000,
    });

    // Verify the file was modified (console.log removed or replaced)
    const fixedContent = readFileSync(join(dir, "app.ts"), "utf-8");
    expect(fixedContent).not.toContain("console.log");

    // Verify oxlint now passes (exit code 0 means no errors)
    let lintPasses = true;
    try {
      execSync(`${OXLINT_BIN} .`, { cwd: dir, stdio: "pipe" });
    } catch {
      lintPasses = false;
    }
    expect(lintPasses).toBe(true);

    // Verify the agent committed changes (or at least changed the file)
    const diffOutput = execSync("git diff app.ts", { cwd: dir, encoding: "utf-8" });
    const log = execSync("git log --oneline", { cwd: dir, encoding: "utf-8" });
    const commitCount = log.trim().split("\n").length;
    // Agent either committed (2+ commits) or has uncommitted changes (diff non-empty)
    expect(commitCount >= 2 || diffOutput.length > 0).toBe(true);
  });
});
