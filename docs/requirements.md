# Functional Requirements Document

## 1. System Overview

A command line tool to automate some tasks. Such as creating a journal document to keep daily notes in markdown. A git commit command that uses Claude Code to suggest git commit messages and other useful or timesaving cli tools.

## 2. System Architecture

### 2.1 Service Components

1. **command-line interface** - a CLI application that provides various commands

### 2.2 Basic Requirements

- **Separation of Concerns**: Create a modular architecture that separates different functionalities into distinct modules.
- **UX Design**: assumes command line interface with a minimalistic and colorful design.

## 3. Functional Requirements

### 3.1 Journal Service

#### 3.1.1 Settings file Support

- **Target File**: Default `~/.config/towles-tool/towles-tool.settings.ts`
- **File Format**: typescript file which exports a settings object
- **Default Value**: during the first run, the settings file is created with default values

#### 3.1.2 Journal Files creation

- **Journal Types**: there should be different types of journal files, such as `daily-notes`, `meeting`, etc
- **Target File**: Default to something like `~/journal/${year}/${month}/${year}-${MM}-${DD}-${type}.md`
- **Creation Trigger**: Journal files are created when the user runs the `towles-tool journal ${type}` command
- **Update Method**: If the file already exists, no action it taken but the file is opened in the `editor` specified in the settings file

##### 3.1.2.1 Today Command

- **Command**: `towles-tool journal today`
- **Functionality**:
  - creates the markdown file at the journal directory from the settings file if it doesn't already exist.
  - opens the file in the editor specified in the settings file

#### 3.1.3 Claude Code SDK Integration Function

##### 3.1.3.1 Existing Session Integration

- **Session-Specific Sending**: Message sending to specific session ID
- **Context Preservation**: Conversation continuation maintaining existing session context

##### 3.1.3.2 New Session Creation

- **Directory Specification**: New session creation with specified execution directory
- **No Session ID Specified**: Starting new session without session ID

##### 3.1.3.3 Real-time Communication Function

- **Streaming Processing**: Processing streaming responses from Claude Code SDK
- **Data Integration**: Seamless integration display of saved data and real-time responses
- **State Management**: Proper management of sending, receiving, and completion states
