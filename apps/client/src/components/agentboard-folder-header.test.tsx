// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { FolderHeader } from "@/components/agentboard-folder-header";
import { renderWithProviders } from "@/test/render";
import type { FolderData } from "@/lib/agentboard/types";
import type { SessionActions } from "@/lib/agentboard/actions";

const LONG = "docs/anthropic-application-form";

const folder = {
  name: "toolbox",
  dir: "/home/me/code/p/toolbox",
  repoRoot: "/home/me/code/p/toolbox",
  record: { origin: "checkout" },
  dirMissing: false,
  branch: LONG,
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

describe("FolderHeader on the primary checkout", () => {
  it("keeps the checkout name in a block with a width floor, and lets the branch truncate", () => {
    renderWithProviders(
      <FolderHeader
        title="toolbox"
        folder={folder}
        needs={0}
        collapsed={false}
        active={false}
        cursor={false}
        now={0}
        actions={{} as SessionActions}
        onToggle={vi.fn<() => void>()}
        onNewSession={vi.fn<() => void>()}
        onOpenFiles={vi.fn<() => void>()}
        onOpenPreview={vi.fn<() => void>()}
      />,
    );
    const name = screen.getByText("Root");
    expect(name.parentElement?.parentElement).toHaveClass("min-w-40");
    expect(screen.getByText(`⎇ ${LONG}`)).toHaveClass("truncate", "min-w-0");
  });
});
