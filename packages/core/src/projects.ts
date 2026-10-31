// Projects group VMs, e.g. one per codebase or client. A VM's project is
// stored on the VM itself as a provider tag, so every machine sees the same
// grouping; the list of projects you've created lives in local prefs.

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;

/** Throws unless the name is usable as a tag on every provider. */
export function assertProjectName(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new Error(
      `Invalid project name "${name}": use lowercase letters, digits and dashes, starting with a letter or digit (max 30).`,
    );
  }
  return name;
}

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME.test(name);
}
