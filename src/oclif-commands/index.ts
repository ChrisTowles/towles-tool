// Explicit command exports for Bun compiled binaries
// oclif's pattern-based discovery doesn't work with bundled executables

import Config from './config.js'
import GhBranch from './gh-branch.js'
import RalphRun from './ralph/run.js'
import RalphPlan from './ralph/plan.js'
import RalphTaskAdd from './ralph/task/add.js'
import RalphTaskDone from './ralph/task/done.js'
import RalphTaskList from './ralph/task/list.js'
import RalphTaskRemove from './ralph/task/remove.js'
import JournalDailyNotes from './journal/daily-notes.js'
import JournalMeeting from './journal/meeting.js'
import JournalNote from './journal/note.js'

export default {
  config: Config,
  'gh-branch': GhBranch,
  'ralph:run': RalphRun,
  'ralph:plan': RalphPlan,
  'ralph:task:add': RalphTaskAdd,
  'ralph:task:done': RalphTaskDone,
  'ralph:task:list': RalphTaskList,
  'ralph:task:remove': RalphTaskRemove,
  'journal:daily-notes': JournalDailyNotes,
  'journal:meeting': JournalMeeting,
  'journal:note': JournalNote,
}
