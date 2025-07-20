# Requirements Specification - Gemini-CLI Inspired Architecture

## Problem Statement

The current towles-tool architecture uses commander.js routing with basic React components. To support interactive chat functionality while improving overall architecture, we need to adopt simplified patterns from gemini-cli's App.tsx structure, specifically:

1. State-based navigation instead of commander.js routing
2. Enhanced context providers for chat functionality  
3. Streaming message support using React state
4. Modular component organization

## Solution Overview

Refactor towles-tool to use a simplified version of gemini-cli's architecture pattern with state-based navigation and enhanced context management, while maintaining the existing component structure where possible.

## Functional Requirements

### FR1: State-Based Navigation
- Replace commander.js routing with React state-based navigation
- Support switching between commands (journal, git-commit, config, chat) via application state
- Maintain current command functionality while improving navigation architecture

### FR2: Enhanced AppContext
- Extend existing `src/contexts/AppContext.tsx` to include chat-related state
- Add message history, streaming state, and current chat mode
- Preserve existing AppState and CommandContext interfaces

### FR3: Interactive Chat Component
- Create new `src/components/Chat.tsx` component for interactive conversations
- Support streaming message updates using React state
- Real-time message rendering without persistence between sessions

### FR4: Modular Component Organization
- Reorganize components following gemini-cli's structure patterns
- Maintain existing components while improving organization
- Keep current provider composition pattern (AppProvider > ConfigProvider)

## Technical Requirements

### TR1: Modified Entry Point (`src/index.tsx`)
- Remove commander.js dependency and routing logic
- Initialize React app with state-based navigation
- Support command line arguments for initial state (e.g., `towles-tool chat`)

### TR2: Enhanced App Component (`src/App.tsx`)
- Implement state-based routing similar to gemini-cli's conditional rendering
- Add chat mode support alongside existing command modes
- Maintain ErrorBoundary and provider structure

### TR3: Extended AppContext (`src/contexts/AppContext.tsx`)
- Add chat-related state management:
  ```typescript
  interface ChatState {
    messages: Message[]
    isStreaming: boolean
    currentInput: string
  }
  ```
- Extend AppState to include navigation state and chat mode

### TR4: New Chat Infrastructure
- **File: `src/components/Chat.tsx`** - Main chat interface component
- **File: `src/hooks/useChat.ts`** - Chat logic and state management
- **API Client**: Separate from existing claude-service.ts (per requirement)

### TR5: Updated Types (`src/types.ts`)
- Add chat-related interfaces (Message, ChatState, NavigationState)
- Extend existing AppState interface
- Maintain backward compatibility with existing types

## Implementation Patterns

### State Management Pattern
Follow gemini-cli's provider composition but simplified:
```typescript
<ErrorBoundary>
  <AppProvider> {/* Extended with chat state */}
    <ConfigProvider>
      <AppContent /> {/* State-based routing */}
    </ConfigProvider>
  </AppProvider>
</ErrorBoundary>
```

### Navigation Pattern
Replace commander.js with state-based routing:
```typescript
// Current: commander.js routes to different commands
// New: AppState.currentView determines rendered component
if (appState.currentView === 'chat') return <Chat />
if (appState.currentView === 'git-commit') return <GitCommit />
// etc.
```

### Chat Streaming Pattern
Use React state for real-time updates:
```typescript
const [messages, setMessages] = useState<Message[]>([])
const [streamingContent, setStreamingContent] = useState('')
// Update streamingContent as tokens arrive
```

## Acceptance Criteria

### AC1: Navigation
- [ ] App launches without commander.js dependency
- [ ] Can switch between existing commands (journal, git-commit, config) via state
- [ ] Can enter chat mode and return to other commands
- [ ] Command line arguments set initial navigation state

### AC2: Chat Functionality  
- [ ] Interactive chat interface renders and accepts input
- [ ] Messages stream in real-time using React state updates
- [ ] Chat sessions are temporary (no persistence between runs)
- [ ] Separate API client handles chat requests (not claude-service.ts)

### AC3: Architecture
- [ ] AppContext includes chat state alongside existing state
- [ ] Component organization follows improved modular structure
- [ ] Existing functionality (journal, git-commit, config) remains unchanged
- [ ] ErrorBoundary and provider composition maintained

### AC4: Code Quality
- [ ] TypeScript types updated for new interfaces
- [ ] Existing tests pass with minimal modifications
- [ ] New components follow existing patterns and conventions
- [ ] No breaking changes to existing command interfaces

## Assumptions

1. **No theming system needed** - Keep simple styling approach
2. **No plugin architecture** - Focus on core chat functionality
3. **Temporary chat sessions** - No history persistence required
4. **New API client** - Separate from existing claude-service for chat
5. **Backward compatibility** - Existing commands work identically
6. **Single package structure** - No need for gemini-cli's two-package approach

## Out of Scope

- Plugin/extension system
- Theme customization
- Chat history persistence
- Multiple conversation threads
- Integration with existing claude-service.ts
- Multi-package architecture refactor