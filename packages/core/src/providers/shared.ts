// Instances we manage are recognised by this name prefix, since one cloud
// account may also hold unrelated instances.
export const VM_NAME_PREFIX = "agent-vm-";

export function requireEnv(env: NodeJS.ProcessEnv, label: string, names: string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`${label} is missing ${missing.join(", ")} in .env (see .env.example).`);
}
