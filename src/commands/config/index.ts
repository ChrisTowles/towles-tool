import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "config", description: "Configuration management commands" },
  subCommands: {
    show: () => import("./show.js").then((m) => m.default),
    validate: () => import("./validate.js").then((m) => m.default),
    schema: () => import("./schema.js").then((m) => m.default),
    reset: () => import("./reset.js").then((m) => m.default),
  },
});
