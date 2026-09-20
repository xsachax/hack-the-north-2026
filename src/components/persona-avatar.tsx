import Image from "next/image";
import { surferColor } from "@/lib/persona-sprites";

export function PersonaAvatar({ id, name, state = "idle", slot }: {
  id: string; name?: string; state?: "idle" | "working"; slot?: number;
}) {
  const color = surferColor(id, slot);
  return <picture className="persona-avatar" data-sprite-state={state} data-sprite-color={color}>
    <source media="(prefers-reduced-motion: reduce)" srcSet={`/surfers/static/avatar-${color}.svg`} />
    <Image src={`/surfers/animated/avatar-${color}-${state}.svg`} width={64} height={64}
      unoptimized alt={name ? `${name}'s surfer` : ""} />
  </picture>;
}
