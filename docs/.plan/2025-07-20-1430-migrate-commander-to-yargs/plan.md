# Migration Plan: Commander.js to Yargs

## User Request
Migrate the argument parsing to use yargs instead of commander

## Plan Status
- Phase: Setup ✓
- Phase: Explore ✓
- Phase: Plan ✓
- Phase: Confirm ✓
- Phase: Code (starting)

## Problem Statement
The current CLI uses commander.js v14.0.0 for argument parsing and command registration. We need to migrate to yargs to take advantage of its enhanced features, better TypeScript support, and more flexible command configuration patterns. The migration must preserve all existing functionality including:

- Command aliases (`j` for `journal`, `gc` for `git-commit`, `cfg` for `config`)
- Subcommand structure (journal has daily-notes, meeting, note subcommands)
- Argument parsing patterns (optional strings, rest parameters)
- Integration with existing command modules and Ink UI components

## High-Level Solution Overview
1. **Replace commander.js with yargs** in the main CLI entry point (`src/index.tsx`)
2. **Update package.json** to use yargs instead of commander
3. **Preserve command structure** using yargs command modules pattern
4. **Maintain TypeScript compatibility** with proper type definitions
5. **Keep existing command handlers** unchanged to minimize refactoring
6. **Ensure all aliases and argument patterns work identically**

## Specific Files to Modify

### Primary Changes
- **`src/index.tsx`**: Complete rewrite of CLI setup using yargs patterns
- **`package.json`**: Replace commander dependency with yargs + @types/yargs

### No Changes Required
- **`src/commands/`**: All command implementation files remain unchanged
- **`src/components/`**, **`src/utils/`**, **`src/lib/`**: No changes needed
- **Test files**: Command tests should continue working unchanged

## Implementation Patterns to Follow

### Command Module Structure
Based on yargs best practices, we'll use the command modules pattern:

```typescript
// Current commander pattern:
program.command('journal').alias('j').description('...')
  .command('daily-notes').alias('today').action(...)

// New yargs pattern:
yargs(hideBin(process.argv))
  .command('journal', 'description', journalBuilder, journalHandler)
  .command(['config', 'cfg'], 'description', configBuilder, configHandler)
```

### Alias Handling
- **Simple aliases**: Use array syntax `['config', 'cfg']` in command definition
- **Subcommand aliases**: Handle in builder functions using nested command definitions

### Argument Parsing
- **Optional arguments**: `[title]` becomes positional configuration in builder
- **Rest parameters**: `[message...]` becomes array-type positional argument
- **Type safety**: Use proper TypeScript interfaces for argv

## Technical Constraints and Considerations

### Dependencies
- **Current**: `commander@14.0.0` (ESM compatible, TypeScript built-in)
- **Target**: `yargs@17.x` + `@types/yargs` (latest stable with full TypeScript support)
- **Compatibility**: Both support ESM and work with current Node.js 22.x setup

### Integration Points
- **Ink Components**: No changes - yargs argv objects work identically
- **Config Loading**: No changes - c12 config loading happens before CLI parsing
- **Error Handling**: Similar patterns - both support async command handlers
- **Build System**: No changes - unbuild handles both libraries equally

### Command Structure Mapping
```typescript
// Current: journal command with subcommands
const journalCmd = program.command('journal').alias('j')
journalCmd.command('daily-notes').alias('today').action(...)
journalCmd.command('meeting [title]').alias('m').action(...)

// Target: yargs command modules
yargs.command('journal', 'description', (yargs) => {
  return yargs
    .command(['daily-notes', 'today'], 'description', {}, handler)
    .command(['meeting [title]', 'm'], 'description', builder, handler)
}, () => {}) // parent handler
```

## Discovery Answers
1. **Command Structure**: Hierarchical with journal parent command and 3 subcommands
2. **Aliases**: Each command and subcommand has exactly one alias
3. **Arguments**: Only optional string arguments and rest parameters, no options/flags
4. **Integration**: Commands delegate to separate modules, no CLI logic in main entry
5. **Error Handling**: Async command handlers with top-level try-catch in main()

## User Confirmation Answers
1. **Command Alias Strategy**: ✓ Keep existing alias structure unchanged
2. **Command Module Organization**: ✓ Keep centralized approach in index.tsx
3. **TypeScript Integration**: ✓ Add yargs TypeScript integration for better type safety
4. **Dependency Strategy**: ✓ Use latest stable yargs 17.x version
5. **Error Handling**: ✓ Use yargs enhanced error handling and validation features

## Questions for User

### Question 1: Command Alias Strategy
**Should we maintain the exact same command alias structure, or would you prefer to use yargs' enhanced alias capabilities (like multiple aliases per command)?**

**Smart Default**: Maintain exact same aliases to ensure zero breaking changes for existing users
- `j` → `journal`
- `gc` → `git-commit` 
- `cfg` → `config`
- `today` → `journal daily-notes`
- `m` → `journal meeting`
- `n` → `journal note`

### Question 2: Command Module Organization
**Would you like to keep all commands in the main index.tsx file (current approach) or migrate to yargs' command modules pattern with separate command definition files?**

**Smart Default**: Keep current centralized approach in index.tsx to minimize refactoring, as the current command count (3 main commands) doesn't justify the complexity of separate command modules.

### Question 3: TypeScript Integration Approach
**Should we use yargs' built-in TypeScript integration with interfaces, or stick with the current approach of letting command modules handle their own typing?**

**Smart Default**: Use yargs TypeScript integration for the CLI layer while keeping existing command module signatures unchanged, providing better type safety without breaking existing patterns.

### Question 4: Dependency Update Strategy
**Should we update to the latest yargs version (17.x) or use a specific version for stability?**

**Smart Default**: Use latest stable yargs 17.x series (`yargs@^17.7.2`) as it has mature TypeScript support and is widely adopted, with `@types/yargs` for enhanced type definitions.

### Question 5: Error Handling Enhancement
**Would you like to take advantage of yargs' enhanced error handling and validation features, or maintain the current minimal validation approach?**

**Smart Default**: Maintain current minimal validation approach to preserve existing behavior, but add yargs' built-in command suggestions (`.recommendCommands()`) for better UX when users mistype commands.

---
Created: 2025-07-20 14:30
Updated: 2025-07-20 14:45
Status: Ready for Confirmation