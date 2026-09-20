import { personas } from "./personas";

export const surferColors = ["yellow", "blue", "red", "orange", "green", "teal", "purple", "pink"] as const;
export function surferColor(id: string, slot?: number) {
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 0)) throw new Error("invalid_surfer_slot");
  const preset = personas.findIndex((persona) => persona.id === id);
  const seed = slot ?? (preset >= 0 ? preset : [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0));
  return surferColors[seed % surferColors.length];
}
