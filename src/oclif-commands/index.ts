// Explicit command exports for Bun compiled binaries
// oclif's pattern-based discovery doesn't work with bundled executables

import BranchClean from './branch/clean.js'
import Config from './config.js'
import Doctor from './doctor.js'
import GhBranch from './gh-branch.js'
import Install from './install.js'
import Pr from './pr.js'
import RalphRun from './ralph/run.js'
import RalphPlan from './ralph/plan.js'
import RalphMarkerCreate from './ralph/marker/create.js'
import RalphTaskAdd from './ralph/task/add.js'
import RalphTaskDone from './ralph/task/done.js'
import RalphTaskList from './ralph/task/list.js'
import RalphTaskRemove from './ralph/task/remove.js'
import JournalDailyNotes from './journal/daily-notes.js'
import JournalMeeting from './journal/meeting.js'
import JournalNote from './journal/note.js'
import ObserveSetup from './observe/setup.js'
import ObserveStatus from './observe/status.js'
import ObserveReport from './observe/report.js'
import ObserveFlamegraph from './observe/flamegraph.js'
import ObserveSession from './observe/session.js'

export default {
  'branch:clean': BranchClean,
  config: Config,
  doctor: Doctor,
  'gh-branch': GhBranch,
  install: Install,
  pr: Pr,
  'ralph:run': RalphRun,
  'ralph:plan': RalphPlan,
  'ralph:marker:create': RalphMarkerCreate,
  'ralph:task:add': RalphTaskAdd,
  'ralph:task:done': RalphTaskDone,
  'ralph:task:list': RalphTaskList,
  'ralph:task:remove': RalphTaskRemove,
  'journal:daily-notes': JournalDailyNotes,
  'journal:meeting': JournalMeeting,
  'journal:note': JournalNote,
  'observe:setup': ObserveSetup,
  'observe:status': ObserveStatus,
  'observe:report': ObserveReport,
  'observe:flamegraph': ObserveFlamegraph,
  'observe:session': ObserveSession,
  // Aliases
  flame: ObserveFlamegraph,
}
