const BASE = "http://localhost:4200";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function apiRaw(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
}

export async function createTestRepo(name?: string) {
  return api<{ id: number; name: string }>("/api/repos", {
    method: "POST",
    body: JSON.stringify({
      name: name ?? `test-repo-${Date.now()}`,
      org: "test",
    }),
  });
}

export async function createTestSlot(repoId: number, path?: string) {
  return api<{ id: number; repoId: number; status: string }>("/api/slots", {
    method: "POST",
    body: JSON.stringify({
      repoId,
      path: path ?? `/tmp/test-slot-${Date.now()}`,
    }),
  });
}

export async function createTestCard(
  repoId: number,
  title: string,
  extras?: Record<string, unknown>,
) {
  return api<{
    id: number;
    title: string;
    column: string;
    status: string;
    repoId: number;
    planId: number | null;
    dependsOn: number[];
  }>("/api/cards", {
    method: "POST",
    body: JSON.stringify({
      title,
      description: `Test: ${title}`,
      repoId,
      ...extras,
    }),
  });
}

export async function getCard(id: number) {
  return api<{
    id: number;
    title: string;
    column: string;
    status: string;
    repoId: number;
    planId: number | null;
    dependsOn: number[];
  }>(`/api/cards/${id}`);
}

export async function moveCard(id: number, column: string) {
  return api<{ ok: boolean }>(`/api/cards/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ column, position: 0 }),
  });
}

export async function updateCard(id: number, fields: Record<string, unknown>) {
  return api<Record<string, unknown>>(`/api/cards/${id}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
}

export async function simulateStopHook(cardId: number) {
  return api<{ ok: boolean; ignored?: boolean }>(`/api/agents/${cardId}/complete`, {
    method: "POST",
    body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
  });
}

export async function simulateFailureHook(cardId: number) {
  return api<{ ok: boolean; ignored?: boolean }>(`/api/agents/${cardId}/failure`, {
    method: "POST",
    body: JSON.stringify({ session_id: "test", hook_event_name: "StopFailure" }),
  });
}

export async function simulateNotificationHook(cardId: number) {
  return api<{ ok: boolean; ignored?: boolean }>(`/api/agents/${cardId}/notification`, {
    method: "POST",
    body: JSON.stringify({ session_id: "test", hook_event_name: "Notification" }),
  });
}

export async function simulateStepCompleteHook(cardId: number) {
  return api<{ ok: boolean; ignored?: boolean }>(`/api/agents/${cardId}/step-complete`, {
    method: "POST",
    body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
  });
}

export async function resetSlot(slotId: number) {
  await api(`/api/slots/${slotId}/lock`, {
    method: "POST",
    body: JSON.stringify({ locked: false }),
  });
}

export async function getSlots() {
  return api<{ id: number; status: string; claimedByCardId: number | null }[]>("/api/slots");
}

export async function createTestPlan(name: string, description?: string) {
  return api<{ id: number; name: string }>("/api/plans", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: description ?? `Test plan: ${name}`,
      prGranularity: "per_card",
    }),
  });
}

export async function getPlan(id: number) {
  return api<{
    id: number;
    name: string;
    cards: {
      id: number;
      title: string;
      column: string;
      status: string;
      dependsOn: number[];
    }[];
  }>(`/api/plans/${id}`);
}

/** Wait for an async condition with polling */
export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export const WS_URL = "ws://localhost:4200/_ws";
