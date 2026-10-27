import * as tasks from "./tasks";
import * as taskResults from "./task-results";
import * as taskSettings from "./task-settings";
import { checkpoint } from "./task-context";
import * as catalog from "./catalog-repository";
import * as runs from "./run-repository";
import * as importers from "./importers";
import * as matching from "./matching";
import * as scheduling from "./scheduling";
import * as operations from "./operations";
import * as browser from "./catalog-browser";
import * as localMatching from "./local-matching";
import * as storeMatching from "./matching-repository";
import * as manualMatching from "./manual-matching";
import * as productDetails from "./product-details";
import * as productCategories from "./product-categories";
import * as categoryReview from "./category-review";
import * as agentCategoryReview from "./agent-category-review";
import * as statistics from "./product-statistics";
import { withLock } from "./database";
import { withLogContext } from "@/nextsignal/adapters/log-context";
export const services = {
  tasks,
  taskResults,
  taskSettings,
  checkpoint,
  catalog,
  runs,
  importers,
  matching,
  scheduling,
  operations,
  browser,
  localMatching,
  storeMatching,
  manualMatching,
  productDetails,
  productCategories,
  categoryReview,
  agentCategoryReview,
  statistics,
  withLock,
  withLogContext,
};
export type AppServices = typeof services;
