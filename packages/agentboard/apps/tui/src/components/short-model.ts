export function shortModel(model: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/\[1m\]$/i, "");
}
