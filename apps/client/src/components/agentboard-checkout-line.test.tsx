// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { CheckoutLine } from "@/components/agentboard-checkout-line";
import { renderWithProviders } from "@/test/render";
import type { FolderData } from "@/lib/agentboard/types";

const folder = {
  name: "toolbox",
  dir: "/home/me/code/p/toolbox",
  repoRoot: "/home/me/code/p/toolbox",
  record: { origin: "checkout" },
  dirMissing: false,
  branch: "docs/anthropic-application-form",
  isWorktree: false,
  uncommittedFiles: 6,
  uncommittedAdded: 98,
  uncommittedRemoved: 8,
  committedFiles: 1,
  committedAdded: 113,
  committedRemoved: 53,
  sessions: [],
  needs: 0,
  quiet: false,
} as unknown as FolderData;

describe("CheckoutLine on the primary checkout", () => {
  it("names the line by its branch and carries its session chips inline", () => {
    renderWithProviders(
      <CheckoutLine
        title="toolbox"
        folder={folder}
        needs={0}
        active={false}
        cursor={false}
        now={0}
        onSelect={vi.fn<() => void>()}
        onNewSession={vi.fn<() => void>()}
        onOpenFiles={vi.fn<() => void>()}
        onOpenPreview={vi.fn<() => void>()}
      >
        <span>chip-a</span>
      </CheckoutLine>,
    );
    expect(screen.getByRole("button", { name: folder.branch })).toHaveClass("truncate");
    expect(screen.getByText("chip-a")).toBeInTheDocument();
  });
});
