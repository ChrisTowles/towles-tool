import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '../config/context'

interface ConfigContextValue {
  context: Context
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

interface ConfigProviderProps {
  children: ReactNode
  context: Context
}

export function ConfigProvider({ children, context }: ConfigProviderProps) {
  return (
    <ConfigContext.Provider value={{ context }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig() {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider')
  }
  return context
}