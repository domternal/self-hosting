import { randomBytes } from 'node:crypto';

const PROJECT_PATTERN = /^domternal(?:-pro)?-e2e-[a-z0-9][a-z0-9-]*$/u;

export function createE2EProjectName(requested, options = {}) {
  if (requested !== undefined) {
    if (
      typeof requested !== 'string' ||
      requested.length > 63 ||
      !PROJECT_PATTERN.test(requested)
    ) {
      throw new Error(
        'E2E_PROJECT_NAME must be a lowercase domternal-e2e-* or domternal-pro-e2e-* name'
      );
    }
    return requested;
  }

  const pid = options.pid ?? process.pid;
  const nonce = options.nonce ?? randomBytes(4).toString('hex');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[0-9a-f]{8}$/u.test(nonce)) {
    throw new Error('Could not create a safe unique E2E Compose project name');
  }
  return `domternal-e2e-local-${String(pid)}-${nonce}`;
}

export function projectCollisionProblems(project, resourceInventory) {
  const problems = [];
  for (const [resource, ids] of Object.entries(resourceInventory)) {
    if (typeof ids !== 'string' || ids.trim() !== '') {
      problems.push(`Compose project ${project} already owns ${resource}`);
    }
  }
  return problems;
}
