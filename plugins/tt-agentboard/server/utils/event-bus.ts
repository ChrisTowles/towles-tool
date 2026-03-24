import { EventEmitter } from "node:events";

export const eventBus = new EventEmitter();

// Event types:
// 'card:moved'          { cardId, fromColumn, toColumn }
// 'card:status-changed' { cardId, status }
// 'step:started'        { cardId, stepId }
// 'step:completed'      { cardId, stepId, passed: boolean }
// 'step:failed'         { cardId, stepId, retryNumber }
// 'slot:claimed'        { slotId, cardId }
// 'slot:released'       { slotId }
// 'agent:output'        { cardId, content }
// 'agent:waiting'       { cardId, question }
// 'workflow:completed'  { cardId, status }
// 'github:issue-found'  { issueNumber, repoId }
