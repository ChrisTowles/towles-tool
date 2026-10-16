import { describe, expect, it } from "vitest";
import { imageExtension } from "./pasted-images";

describe("imageExtension", () => {
  it("maps an image mime to the extension Slack previews inline", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/webp; charset=binary")).toBe("webp");
  });
});
