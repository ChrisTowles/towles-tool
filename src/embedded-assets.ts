/**
 * Embedded assets for compiled binary
 * Uses Bun's embed syntax to bundle files into the executable
 */

// @ts-expect-error - Bun's file embed syntax
import ttCoreZip from "../dist/tt-core.zip" with { type: "file" };

/**
 * Get the path to the embedded tt-core plugin zip
 * In dev mode, this returns the source file path
 * In compiled mode, this returns a temp path to the embedded file
 */
export function getEmbeddedPluginPath(): string {
  return ttCoreZip;
}
