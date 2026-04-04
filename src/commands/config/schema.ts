import { defineCommand } from "citty";
import { z } from "zod/v4";
import { UserSettingsRawSchema } from "../../config/settings.js";

export default defineCommand({
  meta: { name: "schema", description: "Export JSON Schema for the settings file" },
  args: {
    pretty: {
      type: "boolean",
      description: "Pretty-print the JSON output",
      default: true,
    },
  },
  async run({ args }) {
    const jsonSchema = z.toJSONSchema(UserSettingsRawSchema, { target: "draft-2020-12" });
    const indent = args.pretty ? 2 : undefined;
    process.stdout.write(JSON.stringify(jsonSchema, null, indent) + "\n");
  },
});
