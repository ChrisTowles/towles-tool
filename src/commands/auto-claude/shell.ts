export { execSafe, gh, ghRaw, git } from "@towles/shared";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
