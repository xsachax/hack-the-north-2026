import type { ManagedCreate } from "./managed-contracts";

type Assignment = ManagedCreate["assignments"][number];
type Specialist = Assignment & { label: string; purpose: string; checks: readonly string[] };

// Presentation presets reuse existing profiles; stored personas and past runs stay unchanged.
export const managedSpecialists: readonly Specialist[] = [
  {
    personaId: "careful-first-timer", label: "UI/UX",
    purpose: "Find confusing labels, dead ends and missing feedback.",
    checks: ["Clear next steps", "Readable labels", "Navigation feedback"],
    goal: "Review the approved public pages as a first-time visitor. Observe navigation, labels, hierarchy and feedback using read-only browsing. Do not submit forms, authenticate, purchase or change data.",
    criteria: [
      "The main purpose and next step are clear from the visible page.",
      "Navigation labels make destinations understandable, without unexplained dead ends.",
      "Visible feedback explains what happened after read-only navigation.",
    ],
  },
  {
    personaId: "security-minded", label: "Security & privacy",
    purpose: "Review visible trust cues and requests for personal data.",
    checks: ["Privacy disclosures", "Permission explanations", "Trust cues"],
    goal: "Passively review visible privacy, permission and trust information on the approved public pages. Use read-only browsing only. Do not probe vulnerabilities, submit payloads, enter secrets, authenticate or change data. This is not penetration testing.",
    criteria: [
      "Visible requests for personal data or permissions explain their purpose.",
      "Privacy information is easy to locate and uses understandable labels.",
      "Visible trust claims and optional data requests are clear rather than misleading; untested controls are reported as unknown.",
    ],
  },
  {
    personaId: "keyboard-only", label: "Accessibility",
    purpose: "Look for barriers in keyboard navigation and labels.",
    checks: ["Keyboard navigation", "Visible focus", "Control labels"],
    goal: "Observe keyboard navigation, focus and control labels on the approved public pages using read-only browsing. Do not submit forms, authenticate or change data. Report only observed barriers and untested areas, not certified WCAG compliance.",
    criteria: [
      "The observed read-only navigation can be reached and used with the keyboard without a focus trap.",
      "Keyboard focus is visible and follows an understandable order through the observed controls.",
      "Observed links and controls have meaningful labels that explain their purpose.",
    ],
  },
  {
    personaId: "slow-connection", label: "Loading & performance",
    purpose: "Spot stuck loading states and unclear error recovery.",
    checks: ["Loading feedback", "Stuck spinners", "Recovery guidance"],
    goal: "Observe visible loading, content appearance and error recovery on the approved public pages using read-only browsing. Do not repeatedly retry, submit forms, authenticate or change data. Do not claim packet capture, throttling, timing instrumentation or benchmarks; report missing measurement evidence.",
    criteria: [
      "Observed navigation gives understandable loading feedback rather than an unexplained blank state.",
      "Visible loading indicators resolve into content or an explanatory error during the observed journey.",
      "Any observed loading or connection error gives clear recovery guidance; absent error states and timing evidence are reported as untested.",
    ],
  },
];

export const managedDefaultGoal = "Review the approved public pages from this persona's perspective using read-only browsing. Do not submit forms, authenticate, enter sensitive data, purchase or change data. Report observed friction and limitations, not untested claims.";
export const managedDefaultCriteria = [
  "The page purpose and next steps are understandable.",
  "Read-only navigation provides clear labels and feedback.",
  "Observed obstacles are described concretely and untested areas are marked as unknown.",
];

export function managedSpecialistForAssignment(assignment: Assignment) {
  return managedSpecialists.find((specialist) => specialist.personaId === assignment.personaId
    && specialist.goal === assignment.goal
    && specialist.criteria.length === assignment.criteria.length
    && specialist.criteria.every((criterion, index) => criterion === assignment.criteria[index]));
}
