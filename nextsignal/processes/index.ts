import { executeRun, enqueueRun } from "./business/catalog";
import { retailerProcesses } from "./business/retrieve";
import { runJob, matchJob, retailerJobs } from "./distributed/jobs";
import { catalogTick } from "./recurring/catalog";
import * as api from "./api/operations";
export const processes = [
  ...retailerProcesses,
  executeRun,
  enqueueRun,
  runJob,
  matchJob,
  ...retailerJobs,
  catalogTick,
  ...Object.values(api),
];
