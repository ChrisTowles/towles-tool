import { colors } from 'consola/utils'

export const getTerminalColumns = () => process.stdout?.columns || 80

export const limitText = (text: string, maxWidth: number): string => {
  if (text.length <= maxWidth)
    return text
  // subtract 1 so room for the ellipsis
  return `${text.slice(0, maxWidth - 1)}${colors.dim('…')}`
}

/**
 * Convert hex color to RGB values
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleanHex = hex.replace('#', '')
  const r = Number.parseInt(cleanHex.slice(0, 2), 16)
  const g = Number.parseInt(cleanHex.slice(2, 4), 16)
  const b = Number.parseInt(cleanHex.slice(4, 6), 16)
  return { r, g, b }
}

/**
 * Apply hex color to text using ANSI 24-bit color codes
 */
export function printWithHexColor({ msg, hex }: { msg: string; hex: string }): string {
  const colorWithHex = hex.startsWith('#') ? hex : `#${hex}`
  const { r, g, b } = hexToRgb(colorWithHex)

  // Use ANSI 24-bit color: \x1B[38;2;r;g;bm for foreground color
  const colorStart = `\x1B[38;2;${r};${g};${b}m`
  const colorEnd = '\x1B[0m' // Reset color

  return `${colorStart}${msg}${colorEnd}`
}
