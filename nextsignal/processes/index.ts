import { taskJob } from "./distributed/tasks";
import { executeRun, enqueueRun } from "./business/catalog";
import { retailerProcesses } from "./business/retrieve";
import { downloadJob, publicationJob } from "./distributed/jobs";
import { catalogTick } from "./recurring/catalog";
import * as taskApi from "./api/tasks";
import * as categoryApi from "./api/product-categories";
import * as agentCategoryApi from "./api/agent-category-review";
import * as api from "./api/operations";
export const processes = [
  ...retailerProcesses,
  executeRun,
  enqueueRun,
  taskJob,
  downloadJob,
  publicationJob,
  catalogTick,
  ...Object.values(api),
  ...Object.values(taskApi),
  ...Object.values(categoryApi),
  ...Object.values(agentCategoryApi),
];
