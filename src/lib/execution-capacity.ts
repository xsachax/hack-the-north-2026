export const MAX_CONCURRENT_AGENTS = 8;
export const MAX_ASSIGNMENTS_PER_RUN = 8;

// Hashing, saved requests and stored policies must retain their original bounds.
export const HISTORICAL_MAX_ASSIGNMENTS_PER_RUN = 12;
export const HISTORICAL_MAX_CONCURRENT_AGENTS = 12;

export function hasRunCapacity(assignments: readonly unknown[]): boolean {
  return assignments.length >= 1 && assignments.length <= MAX_ASSIGNMENTS_PER_RUN;
}

export function selectRunAssignment(current: string[], id: string, selected = true): string[] {
  if (!selected) return current.filter((value) => value !== id);
  if (current.includes(id) || current.length >= MAX_ASSIGNMENTS_PER_RUN) return current;
  return [...current, id];
}
