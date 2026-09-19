export type Persona = {
  id: string;
  name: string;
  character: string;
  device: "phone" | "desktop";
  techComfort: "low" | "medium" | "high";
  patienceSteps: number;
  readingStyle: "skim" | "careful";
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
