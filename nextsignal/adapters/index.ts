import {
  createSchemaValidationAdapter,
  type NextSignalAdapters,
} from "@gotch/nextsignal";
import { authAdapter } from "@/nextsignal/adapters/auth";
import { loggerAdapter } from "@/nextsignal/adapters/logger";
import { queueAdapter } from "@/nextsignal/adapters/queue";
import { schedulerAdapter } from "@/nextsignal/adapters/scheduler";

// Adapter wiring belongs in one place. Processes depend on `ctx.auth`,
// `ctx.logger`, `ctx.validate`, and `ctx.mediator`, not on provider packages.
export const adapters: NextSignalAdapters = {
  auth: authAdapter,
  logger: loggerAdapter,
  validation: createSchemaValidationAdapter(),
  queue: queueAdapter,
  scheduler: schedulerAdapter,
};
