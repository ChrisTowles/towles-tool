import { defineCommand } from "citty";
import { version } from "../package.json";

export const main = defineCommand({
  meta: { name: "tt", version, description: "towles-tool — personal CLI utilities" },
  subCommands: {
    config: () => import("./commands/config.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
    install: () => import("./commands/install.js").then((m) => m.default),
    agentboard: () => import("./commands/agentboard.js").then((m) => m.default),
    ag: () => import("./commands/agentboard.js").then((m) => m.default),
    gh: () => import("./commands/gh/index.js").then((m) => m.default),
    pr: () => import("./commands/gh/pr.js").then((m) => m.default),
    journal: () => import("./commands/journal/index.js").then((m) => m.default),
    today: () => import("./commands/journal/daily-notes.js").then((m) => m.default),
    "auto-claude": () => import("./commands/auto-claude/index.js").then((m) => m.default),
    ac: () => import("./commands/auto-claude/index.js").then((m) => m.default),
    graph: () => import("./commands/graph/index.js").then((m) => m.default),
  },
});
