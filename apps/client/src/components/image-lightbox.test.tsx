// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import {
  ImageLightbox,
  type LightboxImage,
  lightboxIndex,
  lightboxStep,
} from "@/components/image-lightbox";

const img = (id: string): LightboxImage => ({ id, name: `${id}.png`, previewUrl: `data:,${id}` });
const images = [img("a"), img("b"), img("c")];

describe("lightboxIndex", () => {
  it("finds the open image", () => {
    expect(lightboxIndex(images, "b")).toBe(1);
  });

  it("reports -1 for nothing open and for an image that was detached", () => {
    expect(lightboxIndex(images, null)).toBe(-1);
    expect(lightboxIndex(images, "gone")).toBe(-1);
  });
});

describe("lightboxStep", () => {
  it("moves forward and back", () => {
    expect(lightboxStep(images, "a", 1)).toBe("b");
    expect(lightboxStep(images, "b", -1)).toBe("a");
  });

  it("wraps at both ends", () => {
    expect(lightboxStep(images, "c", 1)).toBe("a");
    expect(lightboxStep(images, "a", -1)).toBe("c");
  });

  it("has nowhere to go when the open image is gone or the list is empty", () => {
    expect(lightboxStep(images, "gone", 1)).toBeNull();
    expect(lightboxStep(images, null, 1)).toBeNull();
    expect(lightboxStep([], "a", 1)).toBeNull();
  });
});

describe("<ImageLightbox>", () => {
  it("shows the open image full size, with nav when there's more than one", () => {
    renderWithProviders(<ImageLightbox images={images} openId="b" onOpenChange={() => {}} />);

    expect(screen.getByRole("img", { name: "b.png" })).toBeInTheDocument();
    expect(screen.getByText("2 of 3 — ← → to move, Esc to close")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous image" })).toBeInTheDocument();
  });

  it("renders nothing when no image is open, and no nav for a single image", () => {
    const { rerender } = renderWithProviders(
      <ImageLightbox images={images} openId={null} onOpenChange={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(<ImageLightbox images={[img("a")]} openId="a" onOpenChange={() => {}} />);
    expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  });
});
