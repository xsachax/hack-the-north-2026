import Browserbase from "@browserbasehq/sdk";
import { z } from "zod";

export interface ContextProvider {
  create(name: string): Promise<string>;
  inspect(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export function createContextProvider(apiKey: string, projectId?: string): ContextProvider {
  if (process.env.DEBUG === "true") throw new Error("context_provider_debug_forbidden");
  const client = new Browserbase({
    apiKey, baseURL: "https://api.browserbase.com", maxRetries: 0, timeout: 10_000,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  return {
    async create(name) {
      const created = await client.contexts.create({ name, ...(projectId ? { projectId } : {}) });
      return z.uuid().parse(created.id);
    },
    async inspect(id) {
      z.uuid().parse(id);
      const context = await client.contexts.retrieve(id);
      if (context.id !== id || (projectId && context.projectId !== projectId)) {
        throw new Error("context_provider_identity_mismatch");
      }
    },
    async delete(id) {
      z.uuid().parse(id);
      await client.contexts.delete(id);
    },
  };
}
