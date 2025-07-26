import { describe, expect, it } from 'vitest'
import { printWithHexColor } from './render'

describe('printWithHexColor', () => {
  it('should handle hex colors with # prefix', () => {
    const result = printWithHexColor({ msg: 'test', hex: '#ff0000' })
    expect(result).toBe('\x1B[38;2;255;0;0mtest\x1B[0m')
  })

  it('should handle hex colors without # prefix', () => {
    const result = printWithHexColor({ msg: 'test', hex: 'ff0000' })
    expect(result).toBe('\x1B[38;2;255;0;0mtest\x1B[0m')
  })

  it('should handle green color correctly', () => {
    const result = printWithHexColor({ msg: 'green', hex: '#00ff00' })
    expect(result).toBe('\x1B[38;2;0;255;0mgreen\x1B[0m')
  })

  it('should handle blue color correctly', () => {
    const result = printWithHexColor({ msg: 'blue', hex: '0000ff' })
    expect(result).toBe('\x1B[38;2;0;0;255mblue\x1B[0m')
  })

  it('should handle mixed RGB values', () => {
    const result = printWithHexColor({ msg: 'purple', hex: '#800080' })
    expect(result).toBe('\x1B[38;2;128;0;128mpurple\x1B[0m')
  })

  it('should handle GitHub-style label colors', () => {
    // GitHub red label color
    const result = printWithHexColor({ msg: 'bug', hex: 'd73a49' })
    expect(result).toBe('\x1B[38;2;215;58;73mbug\x1B[0m')
  })

  it('should handle lowercase hex values', () => {
    const result = printWithHexColor({ msg: 'test', hex: 'abc123' })
    expect(result).toBe('\x1B[38;2;171;193;35mtest\x1B[0m')
  })

  it('should handle uppercase hex values', () => {
    const result = printWithHexColor({ msg: 'test', hex: 'ABC123' })
    expect(result).toBe('\x1B[38;2;171;193;35mtest\x1B[0m')
  })

  it('should handle empty message', () => {
    const result = printWithHexColor({ msg: '', hex: '#ff0000' })
    expect(result).toBe('\x1B[38;2;255;0;0m\x1B[0m')
  })

  it('should handle message with spaces', () => {
    const result = printWithHexColor({ msg: 'hello world', hex: '#ffffff' })
    expect(result).toBe('\x1B[38;2;255;255;255mhello world\x1B[0m')
  })

  it('should handle black color (000000)', () => {
    const result = printWithHexColor({ msg: 'black', hex: '000000' })
    expect(result).toBe('\x1B[38;2;0;0;0mblack\x1B[0m')
  })

  it('should handle white color (ffffff)', () => {
    const result = printWithHexColor({ msg: 'white', hex: 'ffffff' })
    expect(result).toBe('\x1B[38;2;255;255;255mwhite\x1B[0m')
  })

  it('should preserve message content exactly', () => {
    const specialMessage = 'special-chars_123!@#'
    const result = printWithHexColor({ msg: specialMessage, hex: '#123456' })
    expect(result).toBe(`\x1B[38;2;18;52;86m${specialMessage}\x1B[0m`)
  })
})