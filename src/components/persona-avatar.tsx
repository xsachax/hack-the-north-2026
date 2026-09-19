import { personas } from "@/lib/personas";

export function PersonaAvatar({ id, name }: { id: string; name?: string }) {
  const index = personas.findIndex((persona) => persona.id === id);
  const seed = index < 0 ? [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) : index;
  const tones = ["#e0eaa7", "#d1c5f2", "#ffc9a6", "#b8e0df", "#f2bdd0", "#a9caee", "#edcf94", "#bde3c2", "#e1c3d6", "#bdd1f2", "#edd0bd", "#cac5e3"];
  return <svg className="persona-avatar" viewBox="0 0 64 64" role={name ? "img" : undefined} aria-label={name ? `${name}'s character` : undefined} aria-hidden={name ? undefined : true}>
    <rect width="64" height="64" rx={seed % 2 ? 22 : 16} fill={tones[seed % tones.length]} />
    <path d={seed % 3 === 0 ? "M12 28 Q12 10 32 12 Q52 10 52 28 L47 52 H17Z" : seed % 3 === 1 ? "M14 48 L18 18 L32 10 L47 20 L51 48 Q32 59 14 48" : "M10 34 Q10 15 30 18 Q46 7 51 30 Q59 51 34 54 Q12 58 10 34"} fill="#fffdf5" stroke="#263e35" strokeWidth="2" />
    <path d={seed % 2 ? "M21 30 H27 M37 30 H43" : "M23 27 V32 M41 27 V32"} stroke="#263e35" strokeWidth="3" strokeLinecap="round" />
    <path d={seed % 3 === 1 ? "M28 42 Q32 37 37 42" : "M26 40 Q32 47 39 39"} fill="none" stroke="#263e35" strokeWidth="2" strokeLinecap="round" />
    {seed % 2 === 0 && <path d="M16 24 H29 V36 H16Z M35 24 H48 V36 H35Z M29 28 H35" fill="none" stroke="#263e35" strokeWidth="2" />}
  </svg>;
}
