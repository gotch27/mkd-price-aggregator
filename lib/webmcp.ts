export type PageTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
};
type ModelContext = {
  registerTool: (
    tool: PageTool,
    options?: { signal: AbortSignal },
  ) => void | Promise<void>;
  unregisterTool?: (name: string) => void;
};
type Host = { modelContext?: ModelContext };

// The standard moved from Navigator to Document. Keep that browser difference
// here; never install a fake global or replace other pages' registered tools.
export function pageModelContext(documentHost: Host, navigatorHost: Host) {
  return documentHost.modelContext ?? navigatorHost.modelContext;
}
export async function registerPageTools(
  tools: PageTool[],
  documentHost: Host,
  navigatorHost: Host,
  signal: AbortSignal,
) {
  const context = pageModelContext(documentHost, navigatorHost);
  if (!context?.registerTool || signal.aborted) return false;
  const registration = new AbortController();
  const registered: string[] = [];
  const dispose = () => {
    registration.abort();
    for (const name of registered.splice(0)) context.unregisterTool?.(name);
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    for (const tool of tools) {
      if (signal.aborted) break;
      await context.registerTool(tool, { signal: registration.signal });
      registered.push(tool.name);
      if (signal.aborted) dispose();
    }
    return !signal.aborted;
  } catch (error) {
    dispose();
    throw error;
  }
}
