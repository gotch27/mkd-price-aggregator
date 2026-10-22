import { createNextSignalApp } from "@gotch/nextsignal";
import { adapters } from "@/nextsignal/adapters";
import { config } from "@/nextsignal/config";
import { processes } from "@/nextsignal/processes";
import { services } from "@/nextsignal/services";

// The composition root is where the framework meets your application.
// Keep databases, providers, and infrastructure details behind `services`
// and `adapters`, then keep process files focused on lifecycle and flow.
export const app = createNextSignalApp({
  processes,
  services,
  config,
  adapters,
});

export type App = typeof app;
export type AppServices = typeof services;
