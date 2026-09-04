// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SlackScreen } from "@/screens/slack";
import { renderWithProviders } from "@/test/render";

describe("SlackScreen", () => {
  it("renders the browser-dev conversation with reactions and a thread affordance", async () => {
    renderWithProviders(<SlackScreen />);
    expect(await screen.findByText("yes! leaving in about an hour")).toBeInTheDocument();
    // A `:tada:` in the mock text resolves to a character, not literal colons.
    expect(screen.getByRole("img", { name: "tada" })).toHaveTextContent("🎉");
    // Reaction chips carry their shortcode as the title, custom ones included.
    expect(screen.getByTitle(":heart:")).toHaveTextContent("2");
    expect(screen.getByTitle(":shipit:")).toHaveTextContent(":shipit:");
    expect(screen.getByRole("button", { name: /2 replies/ })).toBeInTheDocument();
  });

  it("opens the thread panel on the reply count and closes it again", async () => {
    renderWithProviders(<SlackScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /2 replies/ }));
    expect(await screen.findByText("saturday: swim lessons at 9")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Reply to Danielle…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    expect(screen.queryByText("saturday: swim lessons at 9")).not.toBeInTheDocument();
  });
});
