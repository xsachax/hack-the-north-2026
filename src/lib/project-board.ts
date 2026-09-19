import { z } from "zod";

export const BOARD_STORAGE_KEY = "flash-flood-project-board-v1";
export const projectCategories = ["Research", "Design", "Engineering"] as const;
export const projectSchema = z.strictObject({
  name: z.string().trim().min(1).max(60).refine((name) => !/[\u0000-\u001f\u007f]/.test(name)),
  category: z.enum(projectCategories),
});
export const boardStateSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(projectSchema).max(12),
});
export type BoardState = z.infer<typeof boardStateSchema>;
export type Project = z.infer<typeof projectSchema>;

export function readBoardState(raw: string | null): BoardState {
  if (raw === null) return { version: 1, projects: [] };
  if (raw.length > 4096) throw new Error("Project board storage exceeds its limit.");
  return boardStateSchema.parse(JSON.parse(raw));
}

export function addProject(state: BoardState, input: Project): BoardState {
  const current = boardStateSchema.parse(state);
  const project = projectSchema.parse(input);
  if (current.projects.length >= 12) throw new Error("This synthetic board is full (12 projects). Reset this tab to continue.");
  if (current.projects.some((item) => item.name.toLowerCase() === project.name.toLowerCase())) {
    throw new Error("A project with this name already exists. Choose another name.");
  }
  return boardStateSchema.parse({ ...current, projects: [...current.projects, project] });
}
