import { workflowLoader } from "~~/server/services/workflow-loader";

export default defineEventHandler(() => {
  return workflowLoader.list();
});
