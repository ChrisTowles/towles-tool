import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "gh", description: "GitHub utilities" },
  subCommands: {
    branch: () => import("./branch.js").then((m) => m.default),
    "branch-clean": () => import("./branch-clean.js").then((m) => m.default),
    pr: () => import("./pr.js").then((m) => m.default),
  },
});
