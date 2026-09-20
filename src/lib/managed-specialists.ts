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
  {
    personaId: "non-native-reader", label: "Content clarity",
    purpose: "Check whether the words and examples explain the purpose.",
    checks: ["Plain language", "Useful examples", "Clear explanations"],
    goal: "Read the approved public pages as a non-native reader. Observe whether wording, examples and explanations make the purpose understandable. Use read-only browsing; do not submit forms, authenticate or change data. Distinguish observed confusing wording from personal preferences.",
    criteria: [
      "The visible page explains its purpose in understandable language.",
      "Important terms have helpful explanations or concrete examples.",
      "Visible instructions make the next step understandable without unexplained jargon.",
    ],
  },
];

export const managedIanaDemoScope = {
  targetUrl: "https://www.iana.org/domains/reserved", pathPrefixes: ["/domains/reserved"], allowedSubdomains: [],
};
const demoMissions = [
  { goal: "Observe the page hierarchy and section labels as a first-time visitor.",
    criteria: ["The IANA-managed Reserved Domains heading is visible.", "Section labels distinguish example domains from other reserved names."] },
  { goal: "Passively read the visible IANA identity and published standards references. Do not perform security probing.",
    criteria: ["The page identifies IANA and its administrative purpose.", "Published standards references are visible without signing in or entering personal data."] },
  { goal: "Read the page heading and visible link names. Report keyboard behavior as untested unless actually observed; do not claim WCAG certification.",
    criteria: ["The main heading has meaningful visible text.", "Observed navigation links have descriptive text; any untested keyboard behavior is reported as a limitation."] },
  { goal: "Observe one page load reaching readable content. Do not reload, benchmark or claim unmeasured timings.",
    criteria: ["The page reaches readable content rather than remaining blank.", "Performance claims use observed evidence, with unmeasured timings explicitly reported as unavailable."] },
  { goal: "Read the explanation of example domains and describe whether the concrete examples clarify their purpose.",
    criteria: ["The page explains why example domains exist.", "The names example.com and example.org are recognizable as examples."] },
];
export const managedIanaDemoAssignments: readonly Assignment[] = managedSpecialists.map((specialist, index) => ({
  personaId: specialist.personaId,
  goal: `Use the actual browser to open the initial IANA Reserved Domains page. ${demoMissions[index].goal} Read this one page, take a screenshot and promptly return your observations. Stay on this page; do not follow external links, submit forms, authenticate or change data. Do not wait artificially. Keep this a short read-only visit.`,
  criteria: demoMissions[index].criteria,
}));

export const managedDefaultGoal = "Review the approved public pages from this persona's perspective using read-only browsing. Do not submit forms, authenticate, enter sensitive data, purchase or change data. Report observed friction and limitations, not untested claims.";
export const managedDefaultCriteria = [
  "The page purpose and next steps are understandable.",
  "Read-only navigation provides clear labels and feedback.",
  "Observed obstacles are described concretely and untested areas are marked as unknown.",
];

export function managedSpecialistForAssignment(assignment: Assignment) {
  const same = (preset: Assignment) => preset.personaId === assignment.personaId && preset.goal === assignment.goal
    && preset.criteria.length === assignment.criteria.length
    && preset.criteria.every((criterion, index) => criterion === assignment.criteria[index]);
  return managedSpecialists.find((specialist) => same(specialist)
    || managedIanaDemoAssignments.some((preset) => preset.personaId === specialist.personaId && same(preset)));
}
