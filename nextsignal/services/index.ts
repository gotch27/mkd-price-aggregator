import * as catalog from "./catalog-repository";
import * as runs from "./run-repository";
import * as importers from "./importers";
import * as matching from "./matching";
import * as scheduling from "./scheduling";
import * as operations from "./operations";
import * as browser from "./catalog-browser";
import * as localMatching from "./local-matching";
import { withLock } from "./database";
export const services = {
  catalog,
  runs,
  importers,
  matching,
  scheduling,
  operations,
  browser,
  localMatching,
  withLock,
};
export type AppServices = typeof services;
