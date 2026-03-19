import type { LocalSecretsStore } from "./credential-store";

export function createMemorySecretsStore(): LocalSecretsStore {
  const entries = new Map<string, string>();
  const key = ({ service, name }: { service: string; name: string }) => `${service}:${name}`;

  return {
    get: async (address) => entries.get(key(address)) ?? null,
    set: async ({ service, name, value }) => {
      entries.set(`${service}:${name}`, value);
    },
    delete: async (address) => entries.delete(key(address)),
  };
}
