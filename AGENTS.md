# NextSignal App Agent Guide

This is a Next.js app built with `@gotch/nextsignal`. Backend behavior is modeled as named processes with explicit lifecycle hooks, result envelopes, app-owned services, and infrastructure adapters.

## Commands

- Install dependencies: `npm install`
- Start the Next.js dev server: `npm run dev`
- Type-check the app: `npm run check`
- Build for production: `npm run build`
- Start the production Next.js server after build: `npm run start`
- Start the background worker host: `npm run worker`

Run `npm test` against the isolated database, `npm run smoke` for HTTP checks, and `npm run coverage` to inspect live import progress. Use `npm run setup` only for a new checkout; never overwrite existing secrets.

## Project Map

- `app/api/**/route.ts` contains thin Next.js route handlers.
- `nextsignal/app.ts` is the composition root created with `createNextSignalApp`.
- `nextsignal/config.ts` is the only place that wires configuration providers.
- `app/dashboard.tsx` owns dashboard state and API calls; `app/_components/dashboard/` contains its presentation components and client-safe types.
- `nextsignal/processes/api/` contains route-facing API processes.
- `nextsignal/processes/business/` contains reusable business processes.
- `nextsignal/processes/distributed/` defines queue-backed work and dispatches pending runs.
- `nextsignal/processes/recurring/` defines the minute scheduler bridge.
- `nextsignal/services/` is the app-owned data and provider boundary.
- `nextsignal/services/run-repository.ts` owns run lifecycle and snapshot recovery; `catalog-repository.ts` owns source discovery, staging, and publication.
- `nextsignal/adapters/` connects auth, logging, validation, queue, and scheduler infrastructure.
- `worker/index.ts` starts the separate Node background host.
- `config/default.json` contains explicit, required configuration.
- `.env.local` contains local development overrides.
- `.env.production.local.example` documents production-style overrides for local simulation.
- `docs/architecture.md` maps modules to the ingestion, matching, and operations workflows.

## Configuration Rules

Configuration is loaded through `nextsignal/config.ts`:

```ts
loadEnvConfig(process.cwd());

export const config = createConfig({
  providers: [
    jsonConfigProvider("config/default.json"),
    envConfigProvider({ prefix: "NEXTSIGNAL_" }),
  ],
});
```

When adding config:

- Add explicit required values to `config/default.json`.
- Add local development values to root `.env.local`.
- Add production-style examples to root `.env.production.local.example`.
- Use the `NEXTSIGNAL_` prefix for environment values.
- Use double underscores for nested config paths. Example: `NEXTSIGNAL_LOGGING__LEVEL=debug` maps to `logging.level`.
- Read required configuration through `ctx.config.require("path")` or validated `settings`. Never add code-level fallbacks, Zod defaults, or implicit operational behavior. Every tunable value must be present in configuration; missing values must fail startup.
- Keep `loadEnvConfig(process.cwd())` in `nextsignal/config.ts` so workers and scripts load the same root env files as Next.js.
- Do not scatter `process.env` reads through process files. Keep config provider wiring centralized in `nextsignal/config.ts`.
- Do not put `.env` files inside `config/`; Next.js only loads env files from the project root.
- Do not use `.env.prod`; Next.js recognizes `.env.production` and `.env.production.local`.

## Process Rules

API, business, and distributed processes should explicitly define:

- `auth`
- `validate`
- `handle`

If a hook has nothing to do, return `ok()`.

```ts
export const createThing = businessProcess({
  name: "things.createBusiness",
  auth: () => ok(),
  validate: () => ok(),
  async handle(ctx, input) {
    return value(await ctx.services.things.create(input));
  },
});
```

Recurring processes are different because they are triggered by the scheduler. They define `schedule`, optional `overlap`, optional `shouldRun`, and `handle`.

Use stable process names in the form `resource.action` or `resource.actionKind`, such as `users.register`, `users.createBusiness`, or `maintenance.pruneLogs`.

## Route Rules

Keep route handlers thin. A route should usually only import the app, set `runtime`, and export a handler from `createNextRoute`.

```ts
import { createNextRoute } from "@gotch/nextsignal/next";
import { app } from "@/nextsignal/app";

export const runtime = "nodejs";
export const POST = createNextRoute(app, "things.create");
```

Do not put business logic, validation logic, database calls, or auth provider calls in route files.

## API Process Pattern

API processes are request-facing. They own request authorization, input validation, and orchestration.

```ts
export const createThingApi = apiProcess<
  CreateThingInput,
  CreateThingOutput,
  AppServices
>({
  name: "things.create",
  auth: requireUser(),
  validate: validateWith(createThingSchema),
  async handle(ctx, input) {
    const created = await ctx.mediator.dispatch<CreateThingInput, Thing>(
      "things.createBusiness",
      input,
    );
    if (!created.ok) return forwardFault(created);
    if (!created.data)
      return systemFail(new Error("Business process returned no data."));

    return value({ thing: created.data });
  },
});
```

## Business Process Pattern

Business processes are reusable application operations. API, distributed, recurring, and test code can dispatch them through the mediator.

```ts
export const createThingBusiness = businessProcess<
  CreateThingInput,
  Thing,
  AppServices
>({
  name: "things.createBusiness",
  auth: () => ok(),
  validate: validateWith(createThingSchema),
  async handle(ctx, input) {
    return value(await ctx.services.things.create(input));
  },
});
```

Extract `handle` to a named function when it grows past roughly 10 lines.

## Services Rules

Services are the app-owned data and integration layer. Put database repositories, ORM clients, provider SDK calls, mailers, storage clients, and external API clients in `nextsignal/services`.

Processes should call services through `ctx.services`.

Do not import database clients, provider SDKs, queues, or mailers directly into process files unless the app has intentionally made that service the boundary.

## Adapter Rules

Adapters own infrastructure behavior:

- auth provider lookup
- logger sinks and formatting
- schema validation integration
- queue enqueueing, retries, locks, polling, and dead letters
- scheduler timing, missed-run behavior, and distributed locking

Processes own lifecycle, result envelopes, mediator orchestration, and business intent.

## Result Rules

Return result envelopes from processes:

- `value(data)` for success with data
- `ok()` for success without data
- `validationFail(...)` for expected validation failures
- `authFail(...)` for unauthenticated callers
- `forbidden(...)` for unauthorized callers
- `notFound(...)` for missing resources
- `fail(...)` for expected business failures
- `systemFail(error)` for unexpected system failures

Avoid throwing for expected business, validation, auth, forbidden, or not-found outcomes. Throw only for unexpected system failures, or convert them to `systemFail(error)`.

When forwarding a failed mediator result from one process to another, use:

```ts
if (!result.ok) return forwardFault(result);
```

This preserves the original fault metadata while matching the current process output type.

## Validation Rules

The application defines Zod input schemas alongside its API processes in `nextsignal/processes/api/operations.ts`. NextSignal only depends on the validation adapter contract.

Use `validateWith(schema)` in process definitions. Keep input schemas focused on process input: body fields, query values, route params, and command payloads.

Do not validate auth headers as process input. Auth adapters should read request headers through `ctx.request`.

## Background Work Rules

Use distributed processes for queue-backed work and recurring processes for scheduled work.

Run background work in the separate worker runtime:

```bash
npm run worker
```

Do not run durable queue consumers or schedulers inside route handlers. The background host in `worker/index.ts` is the place to grow production worker behavior.

## Import And Style Rules

- Use the `@/` alias for app imports.
- Keep TypeScript strict-friendly and avoid `any` unless the boundary truly requires it.
- Keep process files focused on lifecycle and flow.
- Keep services boring and provider-oriented.
- Keep adapters provider-specific and infrastructure-oriented.
- After changing imports, process types, config, or adapters, run `npm run check`.
- After larger changes, run `npm run build`.

## Framework Docs

Use these docs for deeper framework details:

- Process lifecycle: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/concepts/process-lifecycle.md
- Result envelopes: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/concepts/result-envelopes.md
- Mediator chaining: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/concepts/mediator-chaining.md
- Services: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/concepts/services.md
- Configuration: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/concepts/configuration.md
- Next.js routes: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/runtime/next-routes.md
- Auth: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/runtime/auth.md
- Validation: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/runtime/validation.md
- Background workflows: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/runtime/background-workflows.md
- Recurring processes: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/runtime/recurring-processes.md
- Adapters: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/infrastructure/adapters.md
- Conventions: https://github.com/gotch27/gotch-nextsignal/blob/main/docs/guides/conventions.md

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
