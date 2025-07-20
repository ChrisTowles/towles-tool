import { useState, useEffect } from 'react'
import type { TerminalSize } from '../types.js'

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  })

  useEffect(() => {
    const updateSize = () => {
      setSize({
        columns: process.stdout.columns || 80,
        rows: process.stdout.rows || 24
      })
    }

    process.stdout.on('resize', updateSize)
    
    return () => {
      process.stdout.off('resize', updateSize)
    }
  }, [])

  return size
}