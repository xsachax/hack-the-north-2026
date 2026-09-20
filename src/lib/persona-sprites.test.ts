import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { personaProfileSchema } from "./contracts";
import { personas, personaTemplates } from "./personas";
import { surferColor, surferColors } from "./persona-sprites";

it("has eight distinct session colors and stable saved-persona colors", () => {
  expect(new Set(Array.from({ length: 8 }, (_, slot) => surferColor("same-persona", slot))).size).toBe(8);
  expect(surferColor("custom-id")).toBe(surferColor("custom-id"));
  expect(() => surferColor("id", -1)).toThrow("invalid_surfer_slot");
});

it("serves local isolated SVGs with reduced-motion alternatives", async () => {
  for (const color of surferColors) {
    for (const variant of [`static/avatar-${color}`, `animated/avatar-${color}-idle`, `animated/avatar-${color}-working`]) {
      const svg = await readFile(`public/surfers/${variant}.svg`, "utf8");
      expect(svg).toContain('viewBox="0 0 1024 1024"');
      expect(svg).not.toMatch(/<script|<foreignObject|<!DOCTYPE|<!ENTITY|@import|\bon(?:load|error)\s*=/i);
      expect(svg).not.toMatch(/href=["'](?!#)|url\((?!#)/);
      if (variant.startsWith("animated/")) expect(svg).toContain("prefers-reduced-motion: reduce");
    }
  }
});

it("offers editable specialty templates without rewriting historical built-ins", () => {
  expect(personas).toHaveLength(12);
  expect(personaTemplates.map((template) => template.id)).toEqual(["security-review", "ux-review", "network-review"]);
  for (const template of personaTemplates) expect(() => personaProfileSchema.parse(template.profile)).not.toThrow();
  expect(personaTemplates[0].profile.character).toContain("Never probes exploits");
  expect(personaTemplates[2].profile.character).toContain("only when the tools supply actual measurements");
});
