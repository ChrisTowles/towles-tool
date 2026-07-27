// @vitest-environment jsdom
//
// Render-level guard for the permission card. The card's *branching* is tested
// as pure functions in `lib/agent.test.ts`; what can only be checked by
// rendering is that the option rows come out as real, correctly-roled form
// controls — the reason they are Radix primitives rather than
// `div role="checkbox"` — and that a click on the row's label reaches them.
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { PermissionCard } from "@/components/agent-prompt-card";
import type { PermissionRequest } from "@/lib/agent";

const request = (
  input: Record<string, unknown>,
  toolName = "AskUserQuestion",
): PermissionRequest => ({
  requestId: "r1",
  toolName,
  displayName: null,
  description: null,
  toolUseId: "t1",
  input,
  suggestions: [],
  requiresUserInteraction: true,
});

const single = {
  questions: [
    {
      question: "Colour?",
      multiSelect: false,
      options: [{ label: "Red", description: "warm" }, { label: "Blue" }],
    },
  ],
};

const multi = {
  questions: [{ question: "Sizes?", multiSelect: true, options: [{ label: "S" }, { label: "L" }] }],
};

describe("PermissionCard: question", () => {
  it("renders a single-select as radios, including the Other choice", () => {
    renderWithProviders(<PermissionCard agentId="a" request={request(single)} />);
    expect(screen.getByText("Colour?")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    // Two authored options plus the CLI's own free-text choice.
    expect(radios).toHaveLength(3);
    expect(screen.getByText("warm")).toBeInTheDocument();
  });

  it("renders a multi-select as checkboxes", () => {
    renderWithProviders(<PermissionCard agentId="a" request={request(multi)} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("names each control from its row, so the whole row is the click target", () => {
    // The accessible name can only come from the `<label htmlFor>` wrapping the
    // control. If that association broke, these queries would find nothing and
    // only the 14px control itself would be clickable in the real app.
    renderWithProviders(<PermissionCard agentId="a" request={request(single)} />);
    expect(screen.getByRole("radio", { name: /Red/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Blue/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Other/ })).toBeInTheDocument();
  });

  it("selects an option and records it", () => {
    renderWithProviders(<PermissionCard agentId="a" request={request(single)} />);
    fireEvent.click(screen.getByRole("radio", { name: /Red/ }));
    expect(screen.getByRole("radio", { name: /Red/ })).toBeChecked();
  });

  it("keeps Send disabled until an answer would actually be sent", () => {
    renderWithProviders(<PermissionCard agentId="a" request={request(single)} />);
    const send = screen.getByRole("button", { name: /^Send/ });
    expect(send).toBeDisabled();
    // "Other" with nothing typed resolves to no answer, so it must not enable
    // Send — that would silently behave as Skip.
    fireEvent.click(screen.getByRole("radio", { name: /Other/ }));
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Your answer"), { target: { value: "puce" } });
    expect(send).toBeEnabled();
  });

  it("offers Skip, which is an allow rather than a refusal", () => {
    renderWithProviders(<PermissionCard agentId="a" request={request(single)} />);
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
  });
});

describe("PermissionCard: gate and plan", () => {
  it("renders a gate with allow and deny", () => {
    renderWithProviders(
      <PermissionCard agentId="a" request={request({ file_path: "/tmp/x" }, "Write")} />,
    );
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny…" })).toBeInTheDocument();
  });

  it("renders a plan with its own wording", () => {
    renderWithProviders(
      <PermissionCard agentId="a" request={request({ plan: "do it" }, "ExitPlanMode")} />,
    );
    expect(screen.getByRole("button", { name: "Approve plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request changes…" })).toBeInTheDocument();
  });
});
