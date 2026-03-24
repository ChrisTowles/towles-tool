# AgentBoard — Implementation Plan for Claude Code

## Project Overview

AgentBoard (`tt ag`) is an agentic workflow orchestration IDE that provides a visual kanban control plane for orchestrating Claude Code agents across workspace slots. It is a personal power tool for a single developer who works across 15+ repos, some cloned multiple times for parallel agent work with isolated .env and port configs.

AgentBoard is three tools in one:

1. **Visual kanban board** — drag-and-drop cards with color-coded status borders and step progress bars
2. **Configurable workflow engine** — YAML-defined pipelines (replacing the existing `tt auto-claude` CLI) with step sequencing, retry logic, and artifact detection
3. **Workspace resource scheduler** — slot allocation across cloned repos, automatic claiming/releasing

It lives inside the `towles-tool` monorepo as a plugin, invoked via `tt ag` or `tt agentboard`.

## Tech Stack

| Layer               | Technology                                                          | Notes                                                                                                                            |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Package Manager     | pnpm                                                                | Strict hoisting, fast installs                                                                                                   |
| Runtime             | Node.js                                                             | NOT Bun — Bun has unresolved Nuxt 4 compat issues (memory leaks, broken POST in dev, HMR failure on Linux, crossws build errors) |
| Frontend            | Nuxt 4 (Vue 3)                                                      | File-based routing, composables, Nitro server                                                                                    |
| UI                  | Tailwind CSS + vuedraggable (or @atlassian/pragmatic-drag-and-drop) | Kanban drag-and-drop                                                                                                             |
| Backend             | Nitro (Nuxt server routes)                                          | Colocated API routes, WebSocket via crossws                                                                                      |
| Database            | SQLite via Drizzle ORM + better-sqlite3                             | Single file, zero infra                                                                                                          |
| Agent Execution     | tmux sessions + Claude Code CLI (`child_process.spawn`)             | Persistent PTY sessions                                                                                                          |
| Terminal in Browser | xterm.js (read-only) + ttyd (interactive attach)                    | Dual-mode access                                                                                                                 |
| Real-time           | WebSockets (crossws in Nitro)                                       | Terminal streaming + status push                                                                                                 |
| Voice               | Browser SpeechRecognition API (MVP)                                 | Upgrade to AWS Transcribe/Whisper later                                                                                          |
| GitHub              | Octokit                                                             | Issues, labels, branches, PRs                                                                                                    |

## Critical Constraints

- **DO NOT use Bun as the runtime.** Use Node.js. Bun is only acceptable as an alternative package manager if pnpm is unavailable.
- **All workflow definitions are YAML files in repos**, not stored in the database. AgentBoard reads them; editing happens in the repo.
- **Every agent runs in a named tmux session.** No direct subprocess management without tmux.
- **Full auto-chain by default.** Steps auto-trigger the next. No manual approval gates in the pipeline.
- **Phone accessibility matters.** The UI must be responsive and usable on a phone via LAN IP.

---

## Directory Structure

```
towles-tool/
├── plugins/
│   └── tt-agentboard/
│       ├── package.json
│       ├── nuxt.config.ts
│       ├── drizzle.config.ts
│       ├── app/
│       │   ├── app.vue
│       │   ├── pages/
│       │   │   ├── index.vue          # Board view
│       │   │   ├── cards/[id].vue     # Card detail view
│       │   │   ├── plans/[id].vue     # Plan DAG view
│       │   │   ├── workspaces.vue     # Workspace manager
│       │   │   └── workflows.vue      # Workflow manager
│       │   ├── components/
│       │   │   ├── board/
│       │   │   │   ├── KanbanBoard.vue
│       │   │   │   ├── KanbanColumn.vue
│       │   │   │   ├── KanbanCard.vue
│       │   │   │   └── CardProgressBar.vue
│       │   │   ├── card/
│       │   │   │   ├── CardDetail.vue
│       │   │   │   ├── TerminalPanel.vue
│       │   │   │   ├── TtydEmbed.vue
│       │   │   │   ├── DiffPreview.vue
│       │   │   │   └── ArtifactViewer.vue
│       │   │   ├── workspace/
│       │   │   │   ├── SlotRegistry.vue
│       │   │   │   └── SlotCard.vue
│       │   │   ├── voice/
│       │   │   │   └── VoiceInput.vue
│       │   │   └── shared/
│       │   │       ├── StatusBadge.vue
│       │   │       └── RepoBadge.vue
│       │   ├── composables/
│       │   │   ├── useBoard.ts
│       │   │   ├── useCards.ts
│       │   │   ├── useWebSocket.ts
│       │   │   ├── useVoice.ts
│       │   │   └── useNotifications.ts
│       │   └── utils/
│       │       └── constants.ts
│       ├── server/
│       │   ├── api/
│       │   │   ├── cards/
│       │   │   │   ├── index.get.ts
│       │   │   │   ├── index.post.ts
│       │   │   │   ├── [id].get.ts
│       │   │   │   ├── [id].put.ts
│       │   │   │   ├── [id].delete.ts
│       │   │   │   └── [id]/move.post.ts
│       │   │   ├── plans/
│       │   │   │   ├── index.get.ts
│       │   │   │   ├── index.post.ts
│       │   │   │   └── [id].get.ts
│       │   │   ├── repos/
│       │   │   │   ├── index.get.ts
│       │   │   │   └── index.post.ts
│       │   │   ├── slots/
│       │   │   │   ├── index.get.ts
│       │   │   │   ├── index.post.ts
│       │   │   │   ├── [id].put.ts
│       │   │   │   └── [id]/lock.post.ts
│       │   │   ├── workflows/
│       │   │   │   └── index.get.ts
│       │   │   ├── agents/
│       │   │   │   ├── [cardId]/attach.post.ts
│       │   │   │   └── [cardId]/respond.post.ts
│       │   │   └── github/
│       │   │       ├── issues.get.ts
│       │   │       └── sync.post.ts
│       │   ├── routes/
│       │   │   └── ws.ts               # WebSocket handler
│       │   ├── services/
│       │   │   ├── workflow-runner.ts
│       │   │   ├── tmux-manager.ts
│       │   │   ├── slot-allocator.ts
│       │   │   ├── dependency-resolver.ts
│       │   │   ├── context-bundler.ts
│       │   │   ├── github-service.ts
│       │   │   ├── ttyd-manager.ts
│       │   │   └── workflow-loader.ts
│       │   ├── db/
│       │   │   ├── index.ts             # Drizzle client
│       │   │   ├── schema.ts            # All table definitions
│       │   │   └── migrations/
│       │   └── utils/
│       │       ├── event-bus.ts          # Internal event emitter
│       │       └── logger.ts
│       ├── cli/
│       │   └── index.ts                 # tt ag command entry point
│       └── test/
│           ├── services/
│           │   ├── workflow-runner.test.ts
│           │   ├── tmux-manager.test.ts
│           │   ├── slot-allocator.test.ts
│           │   └── dependency-resolver.test.ts
│           └── api/
│               ├── cards.test.ts
│               └── slots.test.ts
```

---

## Database Schema (Drizzle ORM)

Create this in `server/db/schema.ts`:

```typescript
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable("repositories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // e.g. "my-app"
  org: text("org"), // e.g. "christowles"
  defaultBranch: text("default_branch").default("main"),
  githubUrl: text("github_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const workspaceSlots = sqliteTable("workspace_slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repositories.id),
  path: text("path").notNull(), // absolute path to clone
  portConfig: text("port_config"), // JSON: { web: 3003, db: 5435 }
  envPath: text("env_path"), // path to .env file
  status: text("status", { enum: ["available", "claimed", "locked"] }).default("available"),
  claimedByCardId: integer("claimed_by_card_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const boards = sqliteTable("boards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().default("Default"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  prGranularity: text("pr_granularity", { enum: ["per_card", "per_plan"] }).default("per_card"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const cards = sqliteTable("cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  boardId: integer("board_id")
    .notNull()
    .references(() => boards.id),
  title: text("title").notNull(),
  description: text("description"),
  repoId: integer("repo_id").references(() => repositories.id),
  column: text("column", { enum: ["backlog", "ready", "in_progress", "review", "done"] }).default(
    "backlog",
  ),
  position: integer("position").notNull().default(0),
  executionMode: text("execution_mode", { enum: ["headless", "interactive"] }).default("headless"),
  status: text("status", {
    enum: [
      "idle",
      "queued",
      "running",
      "waiting_input",
      "review_ready",
      "done",
      "failed",
      "blocked",
    ],
  }).default("idle"),
  planId: integer("plan_id").references(() => plans.id),
  dependsOn: text("depends_on"), // JSON array of card IDs
  workflowId: text("workflow_id"), // references workflow name from YAML
  githubIssueNumber: integer("github_issue_number"),
  githubPrNumber: integer("github_pr_number"),
  currentStepId: text("current_step_id"),
  retryCount: integer("retry_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id),
  workflowId: text("workflow_id").notNull(),
  slotId: integer("slot_id").references(() => workspaceSlots.id),
  tmuxSession: text("tmux_session"),
  branch: text("branch"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  status: text("status", { enum: ["running", "completed", "failed", "cancelled"] }).default(
    "running",
  ),
});

export const stepRuns = sqliteTable("step_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowRunId: integer("workflow_run_id")
    .notNull()
    .references(() => workflowRuns.id),
  stepId: text("step_id").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "skipped"],
  }).default("pending"),
  artifactPath: text("artifact_path"),
  retryNumber: integer("retry_number").default(0),
});

export const agentLogs = sqliteTable("agent_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowRunId: integer("workflow_run_id")
    .notNull()
    .references(() => workflowRuns.id),
  stepId: text("step_id"),
  timestamp: integer("timestamp", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  stream: text("stream", { enum: ["stdout", "stderr"] }).default("stdout"),
  content: text("content").notNull(),
});
```

---

## Workflow YAML Schema

Workflow files live at `.agentboard/workflows/*.yaml` in each repo. Example:

```yaml
name: auto-claude
description: Issue-to-PR pipeline with plan, implement, simplify, review

triggers:
  github_label: auto-claude # Auto-pickup issues with this label

steps:
  - id: plan
    prompt_template: .agentboard/prompts/plan.md
    artifact: .auto-claude/issue-{issue}/plan.md
    model: opus

  - id: implement
    prompt_template: .agentboard/prompts/implement.md
    artifact: .auto-claude/issue-{issue}/completed-summary.md
    max_iterations: 5

  - id: simplify
    prompt_template: .agentboard/prompts/simplify.md
    artifact: .auto-claude/issue-{issue}/simplify-summary.md

  - id: review
    prompt_template: .agentboard/prompts/review.md
    artifact: .auto-claude/issue-{issue}/review.md
    pass_condition: "first_line_equals:PASS"
    on_fail: "goto:implement"
    max_retries: 2

post_steps:
  create_pr: true
  pr_title_template: "auto-claude: {issue_title}"

labels:
  in_progress: auto-claude-in-progress
  success: auto-claude-review
  failure: auto-claude-failed

branch_template: "auto-claude/issue-{issue}"
artifact_dir: ".auto-claude/issue-{issue}"
```

### TypeScript type for parsed workflow:

```typescript
interface WorkflowDefinition {
  name: string;
  description?: string;
  triggers?: {
    github_label?: string;
  };
  steps: WorkflowStep[];
  post_steps?: {
    create_pr?: boolean;
    pr_title_template?: string;
  };
  labels?: {
    in_progress?: string;
    success?: string;
    failure?: string;
  };
  branch_template?: string;
  artifact_dir?: string;
}

interface WorkflowStep {
  id: string;
  prompt_template: string;
  artifact: string;
  model?: string;
  max_iterations?: number;
  pass_condition?: string;
  on_fail?: string; // "goto:<step_id>"
  max_retries?: number;
}
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1)

**Goal:** A working kanban board that can spawn a single Claude Code agent in a tmux session on a registered workspace slot.

#### Task 1.1: Project Scaffolding

```bash
cd towles-tool/plugins
pnpm create nuxt tt-agentboard
cd tt-agentboard
pnpm add -D drizzle-orm drizzle-kit better-sqlite3 @types/better-sqlite3
pnpm add -D @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
pnpm add vuedraggable@next
pnpm add octokit yaml chokidar
pnpm add -D @nuxt/ui          # Optional: if you want Nuxt UI components
```

Configure `nuxt.config.ts`:

```typescript
export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  devtools: { enabled: true },
  modules: ["@nuxt/ui"], // Optional
  nitro: {
    experimental: {
      websocket: true,
    },
  },
  devServer: {
    host: "0.0.0.0", // LAN accessible
    port: 4200,
  },
});
```

Configure `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/agentboard.db",
  },
});
```

Create `server/db/index.ts`:

```typescript
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const dbDir = resolve(process.cwd(), "data");
mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(resolve(dbDir, "agentboard.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
```

Run initial migration:

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit migrate
```

Seed a default board:

```typescript
// server/plugins/seed.ts
import { db } from "../db";
import { boards } from "../db/schema";
import { eq } from "drizzle-orm";

export default defineNitroPlugin(async () => {
  const existing = await db.select().from(boards).limit(1);
  if (existing.length === 0) {
    await db.insert(boards).values({ name: "Default" });
  }
});
```

#### Task 1.2: CRUD API Routes

Implement REST endpoints for cards, repos, and slots. Each route file is a Nitro event handler. Keep them thin — validation + DB call + return.

**Cards API pattern:**

```typescript
// server/api/cards/index.get.ts
import { db } from "~/server/db";
import { cards } from "~/server/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const boardId = Number(query.boardId) || 1;
  return db.select().from(cards).where(eq(cards.boardId, boardId)).orderBy(cards.position);
});

// server/api/cards/index.post.ts
import { db } from "~/server/db";
import { cards } from "~/server/db/schema";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const result = await db
    .insert(cards)
    .values({
      boardId: body.boardId || 1,
      title: body.title,
      description: body.description,
      repoId: body.repoId,
      column: body.column || "backlog",
      position: body.position || 0,
      executionMode: body.executionMode || "headless",
      workflowId: body.workflowId,
    })
    .returning();
  return result[0];
});

// server/api/cards/[id]/move.post.ts
import { db } from "~/server/db";
import { cards } from "~/server/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);

  // Update column and position
  await db
    .update(cards)
    .set({
      column: body.column,
      position: body.position,
      updatedAt: new Date(),
    })
    .where(eq(cards.id, id));

  // If moved to in_progress, trigger agent execution
  if (body.column === "in_progress") {
    // TODO Phase 1.4: trigger workflow runner
  }

  return { ok: true };
});
```

Implement all CRUD routes for: cards, repos, slots. Follow the same pattern.

#### Task 1.3: Kanban Board UI

**KanbanBoard.vue** — the main board view:

- Fetch cards via `useFetch('/api/cards')`
- Group cards by `column` into 5 columns: Backlog, Ready, In Progress, Review, Done
- Use vuedraggable for drag-and-drop between columns
- On drop, call `POST /api/cards/{id}/move` with new column and position
- If card is dropped into "In Progress", also trigger agent start

**KanbanCard.vue** — individual card on the board:

- Card border color based on `status`:
  - `failed` → red (`border-red-500`)
  - `waiting_input` → yellow (`border-yellow-400`)
  - `running` → blue (`border-blue-500`)
  - `done` or `review_ready` → green (`border-green-500`)
  - `idle`, `queued`, `blocked` → gray (`border-gray-300`)
- Display: title, repo badge, execution mode icon, elapsed time
- **CardProgressBar.vue**: render workflow step dots based on `currentStepId` and workflow definition
  - `◉` completed, `◎` in progress, `○` pending
  - Show retry count badge if `retryCount > 0`

#### Task 1.4: tmux Session Manager

```typescript
// server/services/tmux-manager.ts
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export class TmuxManager extends EventEmitter {
  private sessions: Map<string, { cardId: number; process?: ChildProcess }> = new Map();

  /** Check if tmux is available */
  isAvailable(): boolean {
    try {
      execSync("which tmux", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Create a named tmux session for a card */
  createSession(cardId: number, cwd: string): string {
    const sessionName = `card-${cardId}`;
    execSync(`tmux new-session -d -s ${sessionName} -c "${cwd}"`, { stdio: "ignore" });
    this.sessions.set(sessionName, { cardId });
    return sessionName;
  }

  /** Send a command to a tmux session */
  sendCommand(sessionName: string, command: string): void {
    // Escape single quotes in the command
    const escaped = command.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t ${sessionName} '${escaped}' Enter`);
  }

  /** Start capturing output from a tmux session via pipe-pane */
  startCapture(sessionName: string, outputCallback: (data: string) => void): void {
    const pipePath = `/tmp/agentboard-${sessionName}.pipe`;

    // Use tmux pipe-pane to redirect output to a named pipe
    // Alternative: poll with tmux capture-pane
    const interval = setInterval(() => {
      try {
        const output = execSync(`tmux capture-pane -t ${sessionName} -p -S -50`, {
          encoding: "utf-8",
          timeout: 2000,
        });
        outputCallback(output);
      } catch {
        // Session may have ended
        clearInterval(interval);
      }
    }, 500);

    const session = this.sessions.get(sessionName);
    if (session) {
      session.process = { kill: () => clearInterval(interval) } as any;
    }
  }

  /** Check if a session exists */
  sessionExists(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t ${sessionName}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a tmux session */
  killSession(sessionName: string): void {
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: "ignore" });
    } catch {
      /* session may already be dead */
    }
    this.sessions.delete(sessionName);
  }

  /** List all agentboard tmux sessions (for reconnect on restart) */
  listSessions(): string[] {
    try {
      const output = execSync('tmux list-sessions -F "#{session_name}"', { encoding: "utf-8" });
      return output
        .trim()
        .split("\n")
        .filter((s) => s.startsWith("card-"));
    } catch {
      return [];
    }
  }
}

export const tmuxManager = new TmuxManager();
```

#### Task 1.5: WebSocket for Terminal Streaming

```typescript
// server/routes/ws.ts
import { tmuxManager } from "../services/tmux-manager";

export default defineWebSocketHandler({
  open(peer) {
    console.log(`[ws] client connected: ${peer.id}`);
  },

  message(peer, message) {
    const data = JSON.parse(message.text());

    if (data.type === "subscribe-terminal") {
      const sessionName = `card-${data.cardId}`;
      if (tmuxManager.sessionExists(sessionName)) {
        tmuxManager.startCapture(sessionName, (output) => {
          peer.send(
            JSON.stringify({
              type: "terminal-output",
              cardId: data.cardId,
              content: output,
            }),
          );
        });
      }
    }
  },

  close(peer) {
    console.log(`[ws] client disconnected: ${peer.id}`);
  },
});
```

#### Task 1.6: Single Agent Execution (End-to-End)

Wire up the card move handler to execute the full flow:

1. Card dragged to "In Progress"
2. Slot allocator finds available slot for the card's repo
3. tmux session created in the slot's directory
4. Claude Code CLI spawned inside the tmux session: `claude --message "{card.description}"`
5. Output streamed via WebSocket to xterm.js in the card detail view
6. When Claude Code exits, card moves to "Review"

```typescript
// server/services/slot-allocator.ts
import { db } from "../db";
import { workspaceSlots } from "../db/schema";
import { eq, and } from "drizzle-orm";

export class SlotAllocator {
  /** Find and claim an available slot for a repo */
  async claimSlot(
    repoId: number,
    cardId: number,
  ): Promise<typeof workspaceSlots.$inferSelect | null> {
    const available = await db
      .select()
      .from(workspaceSlots)
      .where(and(eq(workspaceSlots.repoId, repoId), eq(workspaceSlots.status, "available")))
      .limit(1);

    if (available.length === 0) return null;

    const slot = available[0];
    await db
      .update(workspaceSlots)
      .set({
        status: "claimed",
        claimedByCardId: cardId,
      })
      .where(eq(workspaceSlots.id, slot.id));

    return { ...slot, status: "claimed", claimedByCardId: cardId };
  }

  /** Release a slot when work is done */
  async releaseSlot(slotId: number): Promise<void> {
    await db
      .update(workspaceSlots)
      .set({
        status: "available",
        claimedByCardId: null,
      })
      .where(eq(workspaceSlots.id, slotId));
  }
}

export const slotAllocator = new SlotAllocator();
```

#### Task 1.7: Workspace Slot Registration UI

A settings page at `/workspaces` where you:

- Add a workspace slot: select repo, enter absolute path, set port config and .env path
- See all slots with their current status (available/claimed/locked)
- Lock/unlock slots for manual work
- Remove slots

---

### Phase 2: Workflow Engine (Week 2)

**Goal:** The auto-claude workflow running end-to-end as a YAML-defined pipeline.

#### Task 2.1: Workflow YAML Loader

```typescript
// server/services/workflow-loader.ts
import { readFileSync, existsSync, watch } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { glob } from "glob";

export class WorkflowLoader {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();

  /** Load all workflow definitions from registered repo paths */
  async loadFromRepos(repoPaths: string[]): Promise<void> {
    for (const repoPath of repoPaths) {
      const workflowDir = resolve(repoPath, ".agentboard", "workflows");
      if (!existsSync(workflowDir)) continue;

      const files = await glob(join(workflowDir, "*.yaml"));
      for (const file of files) {
        this.loadFile(file);
      }

      // Watch for changes
      const watcher = watch(workflowDir, (event, filename) => {
        if (filename?.endsWith(".yaml")) {
          this.loadFile(resolve(workflowDir, filename));
        }
      });
      this.watchers.set(workflowDir, watcher);
    }
  }

  private loadFile(path: string): void {
    try {
      const content = readFileSync(path, "utf-8");
      const workflow = parseYaml(content) as WorkflowDefinition;
      this.workflows.set(workflow.name, workflow);
      console.log(`[workflow-loader] Loaded: ${workflow.name} from ${path}`);
    } catch (err) {
      console.error(`[workflow-loader] Failed to load ${path}:`, err);
    }
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  list(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }
}

export const workflowLoader = new WorkflowLoader();
```

#### Task 2.2: Workflow Runner

The core engine. For each card that enters "In Progress":

1. Load the workflow definition by `card.workflowId`
2. Claim a workspace slot via SlotAllocator
3. Create a tmux session in the slot directory
4. Create a git branch (from `branch_template`)
5. For each step in `workflow.steps`:
   a. Render the prompt template (replace `{issue}`, `{issue_title}`, etc.)
   b. Send Claude Code command to the tmux session
   c. Watch for the artifact file to appear (chokidar file watcher)
   d. When artifact appears, check `pass_condition` if defined
   e. If pass: record step as complete, advance to next step
   f. If fail: check `on_fail` directive, handle `goto:` and `max_retries`
   g. Update card `currentStepId` and emit WebSocket event
6. After all steps: execute `post_steps` (create PR, update labels)
7. Release the workspace slot

Key implementation detail for artifact watching:

```typescript
import { watch } from "chokidar";

function waitForArtifact(path: string, timeoutMs: number = 600000): Promise<boolean> {
  return new Promise((resolve) => {
    if (existsSync(path)) {
      resolve(true);
      return;
    }

    const watcher = watch(dirname(path), { ignoreInitial: true });
    const timeout = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, timeoutMs);

    watcher.on("add", (addedPath) => {
      if (resolve(addedPath) === resolve(path)) {
        clearTimeout(timeout);
        watcher.close();
        resolve(true);
      }
    });
  });
}
```

#### Task 2.3: Step Progress Bar

Update the card's `currentStepId` on each step transition. The frontend reads the workflow definition to know total steps and renders:

- `◉` for completed steps
- `◎` for the current step (animated pulse)
- `○` for pending steps
- On retry: rewind dots to the `goto` target step, increment retry badge

#### Task 2.4: Context Bundler

```typescript
// server/services/context-bundler.ts
export class ContextBundler {
  /**
   * Assemble the prompt for a workflow step.
   * Reads the prompt template and replaces variables.
   */
  async buildPrompt(options: {
    step: WorkflowStep;
    card: typeof cards.$inferSelect;
    slotPath: string;
    issueNumber?: number;
    issueTitle?: string;
    previousArtifacts: Map<string, string>; // stepId -> artifact content
    dependencyDiffs?: string[]; // git diffs from parent cards
  }): Promise<string> {
    const templatePath = resolve(options.slotPath, options.step.prompt_template);
    let template = readFileSync(templatePath, "utf-8");

    // Replace template variables
    template = template
      .replace(/{issue}/g, String(options.issueNumber || ""))
      .replace(/{issue_title}/g, options.issueTitle || "")
      .replace(/{card_title}/g, options.card.title)
      .replace(/{card_description}/g, options.card.description || "");

    // Append previous step artifacts as context
    for (const [stepId, content] of options.previousArtifacts) {
      template += `\n\n## Output from ${stepId} step:\n${content}`;
    }

    // Append dependency diffs if available
    if (options.dependencyDiffs?.length) {
      template += `\n\n## Changes from dependency cards:\n${options.dependencyDiffs.join("\n---\n")}`;
    }

    // Append CLAUDE.md if present
    const claudeMdPath = resolve(options.slotPath, "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      template += `\n\n## Project CLAUDE.md:\n${readFileSync(claudeMdPath, "utf-8")}`;
    }

    return template;
  }
}
```

---

### Phase 3: GitHub + Multi-Agent (Week 3)

**Goal:** Full GitHub integration and parallel agent execution.

#### Task 3.1: GitHub Service

- Use Octokit to poll for issues with trigger labels
- Create issues from AgentBoard UI cards
- Manage label transitions (remove trigger, add in-progress, add success/failure)
- Create feature branches
- Create pull requests on workflow completion
- Store GitHub token in env: `GITHUB_TOKEN`

#### Task 3.2: Multi-Agent Slot Allocator

- Configurable `MAX_CONCURRENT_AGENTS` (env var or settings)
- Queue system: cards in "Ready" wait until a slot opens
- On slot release, check queue and auto-start next card
- Track total active agents and prevent exceeding limit

#### Task 3.3: GitHub Issue Polling

- Poll interval: configurable, default 30 seconds
- On labeled issue found:
  1. Check if card already exists for this issue
  2. If not, create a new card bound to the matching workflow
  3. Card enters "Ready" (or "In Progress" if slots available)

#### Task 3.4: Mobile-Responsive Layout

- Board view: horizontal scroll on mobile, cards stack vertically in each column
- Card detail: terminal panel below card info (not side-by-side)
- Agent question input: prominent on mobile, easy to type a response
- Test on actual phone via LAN IP

---

### Phase 4: Interactive + Plans + Voice (Week 4)

**Goal:** Interactive terminal access, plan DAGs, and voice input.

#### Task 4.1: ttyd Integration

```typescript
// server/services/ttyd-manager.ts
import { spawn, type ChildProcess } from "node:child_process";

export class TtydManager {
  private instances: Map<number, { process: ChildProcess; port: number }> = new Map();
  private nextPort = 7680;

  /** Spawn a ttyd instance that attaches to a card's tmux session */
  spawn(cardId: number): number {
    const port = this.nextPort++;
    const sessionName = `card-${cardId}`;

    const proc = spawn(
      "ttyd",
      [
        "--port",
        String(port),
        "--once", // Auto-exit after disconnect
        "--writable",
        "tmux",
        "attach-session",
        "-t",
        sessionName,
      ],
      { stdio: "ignore", detached: true },
    );

    proc.unref();
    this.instances.set(cardId, { process: proc, port });
    return port;
  }

  /** Kill a ttyd instance */
  kill(cardId: number): void {
    const instance = this.instances.get(cardId);
    if (instance) {
      instance.process.kill();
      this.instances.delete(cardId);
    }
  }

  getPort(cardId: number): number | null {
    return this.instances.get(cardId)?.port ?? null;
  }
}
```

#### Task 4.2: Interactive Mode Detection

- Pattern match on Claude Code's stdout for known prompt patterns (e.g., "?" at end of line, input cursors)
- When detected: update card status to `waiting_input`, emit WebSocket event
- Card turns yellow on the board
- User can respond via: ttyd attach in browser, text input in card detail, or tmux attach from terminal

#### Task 4.3: Plan DAG UI

- Plan creation page: add child cards, set dependency edges
- DAG visualization: use a simple directed graph layout (dagre or elkjs)
- Color-code cards by status
- PR granularity toggle per plan

#### Task 4.4: Dependency Resolver

```typescript
// server/services/dependency-resolver.ts
export class DependencyResolver {
  /** Given a card that just completed, find newly unblocked cards */
  async resolveNext(completedCardId: number, planId: number): Promise<number[]> {
    const planCards = await db.select().from(cards).where(eq(cards.planId, planId));

    const readyCards: number[] = [];

    for (const card of planCards) {
      if (card.column !== "backlog" && card.column !== "ready") continue;

      const deps = JSON.parse(card.dependsOn || "[]") as number[];
      if (deps.length === 0) continue;

      const allDone = deps.every((depId) => {
        const dep = planCards.find((c) => c.id === depId);
        return dep?.column === "done";
      });

      if (allDone) {
        await db.update(cards).set({ column: "ready" }).where(eq(cards.id, card.id));
        readyCards.push(card.id);
      }
    }

    return readyCards;
  }
}
```

#### Task 4.5: Voice Input

- `VoiceInput.vue` component with microphone toggle button
- Uses `window.SpeechRecognition` (or `webkitSpeechRecognition`)
- On transcription complete: open a "New Card" dialog pre-filled with transcribed text
- User confirms repo, workflow, and execution mode
- Card created via POST /api/cards

---

## Event Bus Architecture

Services communicate via an internal event bus:

```typescript
// server/utils/event-bus.ts
import { EventEmitter } from "node:events";

export const eventBus = new EventEmitter();

// Event types:
// 'card:moved'          { cardId, fromColumn, toColumn }
// 'card:status-changed' { cardId, status }
// 'step:started'        { cardId, stepId }
// 'step:completed'      { cardId, stepId, passed: boolean }
// 'step:failed'         { cardId, stepId, retryNumber }
// 'slot:claimed'        { slotId, cardId }
// 'slot:released'       { slotId }
// 'agent:output'        { cardId, content }
// 'agent:waiting'       { cardId, question }
// 'workflow:completed'  { cardId, status }
// 'github:issue-found'  { issueNumber, repoId }
```

The WebSocket handler subscribes to these events and pushes updates to all connected clients.

---

## CLI Entry Point

```typescript
// cli/index.ts
// Registered in towles-tool as the "agentboard" / "ag" command

import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";

export function registerCommand(program: any) {
  const cmd = program
    .command("agentboard")
    .alias("ag")
    .description("Start AgentBoard — agentic workflow orchestration IDE");

  cmd
    .option("-p, --port <port>", "Port to serve on", "4200")
    .option("--no-open", "Do not open browser")
    .action(async (options: { port: string; open: boolean }) => {
      const agentboardDir = resolve(__dirname, "..");
      const port = options.port;

      console.log(`Starting AgentBoard on port ${port}...`);
      console.log(`  Local:   http://localhost:${port}`);
      console.log(`  Network: http://${getLocalIp()}:${port}`);

      const proc = spawn("pnpm", ["dev", "--port", port], {
        cwd: agentboardDir,
        stdio: "inherit",
        env: { ...process.env, NUXT_DEV_HOST: "0.0.0.0" },
      });

      if (options.open) {
        setTimeout(() => execSync(`xdg-open http://localhost:${port}`), 2000);
      }

      proc.on("exit", (code) => process.exit(code || 0));
    });

  cmd
    .command("attach <cardId>")
    .description("Attach to a running card tmux session")
    .action((cardId: string) => {
      execSync(`tmux attach-session -t card-${cardId}`, { stdio: "inherit" });
    });
}
```

---

## Testing Strategy

- **Services:** Unit test workflow runner, slot allocator, dependency resolver, tmux manager with mocked dependencies
- **API routes:** Integration test with a test SQLite database
- **tmux manager:** Only run on CI with tmux installed; skip in environments without it
- **Use vitest** (ships with Nuxt 4)

---

## Environment Variables

```env
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
AGENTBOARD_PORT=4200
AGENTBOARD_DB_PATH=./data/agentboard.db
MAX_CONCURRENT_AGENTS=3
GITHUB_POLL_INTERVAL_MS=30000
```

---

## Key Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.x",
    "chokidar": "^4.x",
    "drizzle-orm": "^0.38.x",
    "octokit": "^4.x",
    "vuedraggable": "^4.x",
    "yaml": "^2.x"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.x",
    "@xterm/xterm": "^5.x",
    "@xterm/addon-fit": "^0.10.x",
    "drizzle-kit": "^0.30.x",
    "nuxt": "^4.x",
    "vitest": "^3.x"
  }
}
```

---

## Summary of Build Order

1. **Scaffold** Nuxt 4 project, install deps, set up Drizzle + SQLite
2. **Schema** — define all tables, run migration, seed default board
3. **API routes** — CRUD for cards, repos, slots
4. **Board UI** — KanbanBoard, KanbanColumn, KanbanCard with drag-and-drop and status colors
5. **tmux manager** — create/kill sessions, capture output
6. **WebSocket** — stream tmux output to xterm.js in card detail
7. **Wire it up** — drag card to In Progress → claim slot → tmux → Claude Code → stream → card to Review
8. **Workflow loader** — parse YAML from repos
9. **Workflow runner** — step sequencing, artifact watching, pass/fail, retry
10. **Step progress bar** — visual pipeline state on cards
11. **GitHub service** — issue polling, label management, branch/PR creation
12. **Multi-agent** — concurrent slot allocation, queue management
13. **ttyd** — on-demand interactive terminal in browser
14. **Plans + DAG** — dependency resolver, auto-chain
15. **Voice** — SpeechRecognition for card creation
