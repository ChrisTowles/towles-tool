import { inspect } from 'node:util'
import { colors } from 'consola/utils'
import consola from 'consola'
import stripAnsi from 'strip-ansi'


export function prettyPrintJson(obj: any) {
  consola.log(inspect(obj, { colors: true, depth: Infinity }))
}

export function visualLength(str: string) {
  if (str === '')
    return 0

  str = stripAnsi(str)

  let width = 0

  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i)
    if (!code)
      continue

    // Ignore control characterscolor
    // Ignore combining characters
    if (code >= 0x300 && code <= 0x36F)
      continue

    // Surrogates
    if (code > 0xFFFF)
      i++

    width += 1
  }

  return width
}

export function visualPadStart(str: string, pad: number, char = ' ') {
  return str.padStart(pad - visualLength(str) + str.length, char)
}

export function visualPadEnd(str: string, pad: number, char = ' ') {
  return str.padEnd(pad - visualLength(str) + str.length, char)
}

export function formatTable(lines: string[][], align: string, spaces = '  ') {
  const maxLen: number[] = []
  lines.forEach((line) => {
    line.forEach((char, i) => {
      const len = visualLength(char)
      if (!maxLen[i] || maxLen[i] < len)
        maxLen[i] = len
    })
  })

  return lines.map(line => line.map((chars, i) => {
    const pad = align[i] === 'R' ? visualPadStart : visualPadEnd
    return pad(chars, maxLen[i])
  }).join(spaces))
}

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
