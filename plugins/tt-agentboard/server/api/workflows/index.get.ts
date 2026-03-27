import { workflowLoader } from "~~/server/domains/execution/workflow-loader";

export default defineEventHandler(() => {
  return workflowLoader.list();
});
