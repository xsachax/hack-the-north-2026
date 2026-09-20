import type { Persona as CanonicalPersona } from "./contracts";

export type Persona = Omit<CanonicalPersona, "quirks" | "worries"> & {
  quirks: readonly string[];
  worries: readonly string[];
};

export const personas = [
  { id: "impatient-mobile", name: "Dana", character: "Between meetings, on her phone.", device: "phone", techComfort: "medium", patienceSteps: 6, readingStyle: "skim", quirks: ["Taps quickly", "Avoids long forms"], worries: ["time"] },
  { id: "careful-first-timer", name: "Alex", character: "New here. Double-checks everything.", device: "desktop", techComfort: "low", patienceSteps: 12, readingStyle: "careful", quirks: ["Looks for reassurance"], worries: ["trust", "mistakes"] },
  { id: "keyboard-only", name: "Sam", character: "Every journey starts with Tab.", device: "desktop", techComfort: "high", patienceSteps: 12, readingStyle: "careful", quirks: ["Uses only the keyboard"], worries: ["accessibility"] },
  { id: "odd-input", name: "Jules", character: "Not the input you were expecting.", device: "desktop", techComfort: "medium", patienceSteps: 10, readingStyle: "skim", quirks: ["Makes typos", "Pastes unusual input"], worries: ["losing progress"] },
  { id: "bargain-hunter", name: "Morgan", character: "There must be another coupon.", device: "desktop", techComfort: "medium", patienceSteps: 12, readingStyle: "careful", quirks: ["Tries multiple coupons"], worries: ["price", "hidden fees"] },
  { id: "returning-user", name: "Casey", character: "Expects things where they left them.", device: "desktop", techComfort: "medium", patienceSteps: 10, readingStyle: "skim", quirks: ["Expects remembered preferences"], worries: ["consistency"] },
  { id: "distracted", name: "Riley", character: "Wait, what was I doing?", device: "phone", techComfort: "medium", patienceSteps: 8, readingStyle: "skim", quirks: ["Pauses", "Returns to earlier pages"], worries: ["losing context"] },
  { id: "non-native-reader", name: "Ari", character: "Clear words beat clever labels.", device: "desktop", techComfort: "medium", patienceSteps: 12, readingStyle: "careful", quirks: ["Interprets labels literally"], worries: ["unclear language"] },
  { id: "privacy-conscious", name: "Robin", character: "No thanks to optional everything.", device: "phone", techComfort: "high", patienceSteps: 10, readingStyle: "careful", quirks: ["Declines optional tracking"], worries: ["privacy", "trust"] },
  { id: "power-user", name: "Dev", character: "Already three clicks ahead.", device: "desktop", techComfort: "high", patienceSteps: 8, readingStyle: "skim", quirks: ["Moves quickly", "Uses shortcuts"], worries: ["time"] },
  { id: "slow-connection", name: "Lee", character: "Waiting for one more spinner.", device: "phone", techComfort: "low", patienceSteps: 6, readingStyle: "skim", quirks: ["Retries when nothing appears to happen"], worries: ["speed", "duplicate actions"] },
  { id: "security-minded", name: "Ash", character: "Questions what a page asks them to trust.", device: "desktop", techComfort: "high", patienceSteps: 12, readingStyle: "careful", quirks: ["Checks visible privacy and trust cues", "Non-destructive checks only"], worries: ["privacy", "unexpected permissions"] },
] as const satisfies readonly Persona[];

export const personaTemplates = [
  {
    id: "security-review", label: "Security and privacy (read-only)",
    profile: {
      name: "Security reviewer", character: "Reviews visible security, privacy and trust cues during the assigned read-only journey. Reports observations and uncertainty, not a vulnerability verdict. Never probes exploits, submits payloads, authenticates, or changes data.",
      device: "desktop", techComfort: "high", patienceSteps: 16, readingStyle: "careful",
      quirks: ["Checks visible permission requests and privacy disclosures", "Distinguishes observed concerns from untested security controls", "Does not request secrets or perform active security testing"],
      worries: ["Unnecessary data collection", "Misleading trust cues", "Unexpected permissions"],
    },
  },
  {
    id: "ux-review", label: "UX and usability",
    profile: {
      name: "UX reviewer", character: "Follows the assigned journey as a first-time visitor, noting unclear labels, navigation problems, confusing hierarchy, missing feedback and obstacles. Grounds recommendations in what was actually observed, without claiming a complete accessibility audit.",
      device: "desktop", techComfort: "medium", patienceSteps: 16, readingStyle: "careful",
      quirks: ["Explains where the next step is unclear", "Checks consistency of labels and feedback", "Separates usability observations from personal preferences"],
      worries: ["Getting lost", "Unclear language", "Missing feedback"],
    },
  },
  {
    id: "network-review", label: "Networking and perceived latency",
    profile: {
      name: "Loading reviewer", character: "Observes the assigned journey for loading delays, stuck spinners, visible connection errors and missing recovery feedback. Reports measured timing only when the tools supply actual measurements; otherwise describes perceived delay. Does not claim packet capture, throttling, DNS/TLS analysis or load testing.",
      device: "phone", techComfort: "high", patienceSteps: 16, readingStyle: "careful",
      quirks: ["Notes visible loading and error states", "Reports absent timing evidence explicitly", "Avoids repeated requests, stress testing and duplicate actions"],
      worries: ["Indefinite loading", "Unclear connection failures", "Missing recovery guidance"],
    },
  },
] as const satisfies readonly { id: string; label: string; profile: Omit<Persona, "id"> }[];
