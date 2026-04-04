import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "journal", description: "Journal and note-taking commands" },
  subCommands: {
    "daily-notes": () => import("./daily-notes.js").then((m) => m.default),
    note: () => import("./note.js").then((m) => m.default),
    meeting: () => import("./meeting.js").then((m) => m.default),
    search: () => import("./search.js").then((m) => m.default),
  },
});
