import type { ManagedCreate } from "./managed-contracts";

type Assignment = ManagedCreate["assignments"][number];
type Specialist = Assignment & { label: string; purpose: string; checks: readonly string[] };

// Presentation presets reuse existing profiles; stored personas and past runs stay unchanged.
export const managedSpecialists: readonly Specialist[] = [
  {
    personaId: "careful-first-timer", label: "UI/UX",
    purpose: "Hunt for misleading labels, dead ends and navigation that changes between pages.",
    checks: ["Clear next steps", "Readable labels", "Navigation feedback"],
    goal: "Review the approved public pages as a first-time visitor using read-only browsing, and hunt for friction rather than confirming that the site works. Visit at least three different pages through the site's own navigation. On each page look for: link or button labels that do not predict where they lead, dead ends (no visible way onward or back, a broken or empty destination), and navigation that changes name, order or position between pages. For every issue quote the exact visible label, heading or sentence and name the page it appeared on. If a link leaves the approved site, record its label and destination host, do not click it again, and continue elsewhere. Do not repeat an action that already failed or showed nothing new. Do not submit forms, authenticate, purchase or change data. A criterion is met only when you checked it on at least three pages and found no problem; a problem found is not_met with the specifics; anything you could not observe is inconclusive.",
    criteria: [
      "On at least three visited pages, every navigation label followed led to a page whose heading matched what the label promised; name any label that did not, quoting the label and the heading it led to, with the page it appeared on. If fewer than three pages were visited, mark this inconclusive.",
      "No visited page was a dead end: each offered a visible way onward and a way back to the main sections; name any page that did not and quote its heading. If a followed link leads to another site, name its label and the destination host.",
      "The main navigation kept the same labels in the same order on every visited page; list the navigation labels seen on each page and quote any label that appeared, vanished or was renamed between pages.",
    ],
  },
  {
    personaId: "security-minded", label: "Security & privacy",
    purpose: "Check where the privacy policy lives, why data is requested and who runs the site.",
    checks: ["Privacy disclosures", "Permission explanations", "Trust cues"],
    goal: "Passively review the visible privacy, data-request and trust information on the approved public pages, using read-only browsing only, and hunt for gaps rather than confirming that the site looks trustworthy. Visit at least three different pages, including the home page and any page that shows a form or asks for personal data. Look for: a privacy policy that is missing, takes more than one click to reach, or is hosted on a different site; fields or permission prompts that ask for personal data without saying why; and pages that never say who operates the site or how to contact them. For every issue quote the exact visible label, heading or sentence and name the page. If the privacy link leaves the approved site, that is itself the finding: record the link label and the destination host, do not click it again, and continue with the other checks. Only look at forms; never type into them. Do not probe vulnerabilities, submit payloads, enter secrets, submit forms, authenticate or change data. This is not penetration testing and says nothing about server-side security; controls you did not observe are reported as unknown. A criterion is met only on quoted evidence; a gap found is not_met with the specifics; anything unobserved is inconclusive.",
    criteria: [
      "A privacy policy link is reachable in one click from the home page AND opens on the approved site; quote the link label and name the page where it was found. If it leads to a different host, name the destination host and mark this not_met; if it stays on this host but outside the approved paths, report it as not explored and mark this inconclusive; if no such link was seen, report that and list the pages checked.",
      "Every visible field or prompt that asks for personal data (name, email, phone, address, account, location) states its purpose next to it; list each such field seen with its page and quote the stated purpose, or name the fields that gave none. If no personal-data field was seen, state that none was seen and mark this inconclusive.",
      "The site states who operates it and how to contact them, on the approved site; quote the operator name and the contact detail exactly as shown and name the page. If either was not found, report which one was missing and which pages were checked; do not assume it exists elsewhere.",
    ],
  },
  {
    personaId: "keyboard-only", label: "Accessibility",
    purpose: "Look for keyboard traps, missing focus indicators and vague link text.",
    checks: ["Keyboard navigation", "Visible focus", "Control labels"],
    goal: "Check the approved public pages for keyboard and labelling barriers using read-only browsing, and hunt for barriers rather than confirming that the site looks tidy. Visit at least three different pages. On each page, when your tools can press keys, press Tab from the top of the page, count the presses until focus reaches the main navigation, note the first controls that received focus, and check whether the focused control shows a visible indicator; when the harness reports focus readings, cite them. Also hunt for vague link text: 'here', 'more', 'click here', bare URLs and icons with no text label. For every issue quote the exact visible label, heading or sentence and name the page. Keyboard and focus verdicts may rest only on keys that were actually pressed: if no key was pressed or no focus reading was provided, mark that criterion untested (inconclusive); never infer keyboard behaviour from page structure or from clicking. Do not submit forms, authenticate or change data. Report only observed barriers and untested areas, not certified WCAG compliance. A barrier found is not_met with the specifics.",
    criteria: [
      "Pressing Tab from the top of the page reaches the main navigation without focus getting trapped or lost; report the number of Tab presses and the focused controls the harness read when it provides them, otherwise mark this untested. If no key was actually pressed this is inconclusive; never infer it from page structure or from clicking.",
      "Each focused control the harness read shows a visible focus indicator; cite the harness focus reading (control and indicator) per page when provided. A reading of 'no outline or box-shadow detected' leaves other styles unchecked: name that control, report its indicator as not detected and mark this inconclusive, not not_met. If no focus reading was provided, report the indicator as unknown and mark this inconclusive.",
      "Every link and control has text that says where it goes or what it does; quote each vague one found ('here', 'more', 'click here', a bare URL, an icon with no label) with the page it appeared on. If none was found, list the pages whose links were read; this covers visible text only, and programmatic labels are untested.",
    ],
  },
  {
    personaId: "slow-connection", label: "Loading & performance",
    purpose: "Find blank, stuck or slow pages, citing load times only when they were measured.",
    checks: ["Loading feedback", "Stuck spinners", "Recovery guidance"],
    goal: "Observe how the approved public pages load, using read-only browsing, and hunt for slow, blank, stuck or broken states rather than confirming that the site feels fast. Visit at least three different pages through the site's own navigation, one load per page. For each page record whether it reached readable content, and cite a load time only when the harness measured and reported one; otherwise write 'unmeasured' for that page. How long a click or step took is not a load time. Never describe speed with impressions such as 'fast' or 'instant' in place of a number. Look for: blank or half-rendered pages, spinners or placeholders that never resolve, layout that jumps after content appears, and error messages that give no way to recover. For every issue quote the exact visible heading, label or sentence and name the page. Do not repeatedly retry or reload, submit forms, authenticate or change data. Do not claim packet capture, throttling, timing instrumentation of your own or benchmarks; report missing measurement evidence. If no delay or error occurred, feedback for delays and errors is untested, not met. A problem found is not_met with the specifics.",
    criteria: [
      "Every visited page reached readable content (a heading plus body text) rather than staying blank, partial or stuck; list each page visited and cite the harness's measured load time per page when provided, otherwise report timing as unmeasured. Name any page that did not reach readable content and quote what was shown instead.",
      "No visited page took longer than 3 seconds to load, judged only by the page timing (DOMContentLoaded or load) or the initial page-open time the harness reported; cite that timing per page and name every page over 3 seconds (any such page makes this not_met). Never judge speed from how long a click or step took, which includes harness overhead. If no such timing was provided, report timing as unmeasured and mark this inconclusive.",
      "When a page was delayed or failed, the site showed feedback that explained what was happening and how to recover; quote the message and name the page. If no delay or error occurred during the visit, report this as untested and mark it inconclusive; the absence of a problem never makes this met.",
    ],
  },
  {
    personaId: "non-native-reader", label: "Content clarity",
    purpose: "Find jargon openers, unexplained terms and instructions a newcomer cannot follow.",
    checks: ["Plain language", "Useful examples", "Clear explanations"],
    goal: "Read the approved public pages as a non-native reader who is new to the subject, using read-only browsing, and hunt for wording that would stop such a reader rather than confirming that the text is well written. Visit at least three different pages. On each page read the opening sentence, the headings and any instructions. Look for: openings that start with jargon or history instead of saying what the page is for, terms and abbreviations used without an explanation or example on that page, and instructions that assume prior knowledge or skip a step. For every issue quote the exact visible label, heading or sentence and name the page. Distinguish observed confusing wording from personal preferences: report a term only when the page itself gives no explanation. Do not submit forms, authenticate or change data. A criterion is met only when you checked it on at least three pages and quoted what you read; a problem found is not_met with the specifics; anything you did not read is inconclusive.",
    criteria: [
      "The opening sentence of each visited page says in plain words what the page is for; quote the opening sentence of each page and name the page. Any page that opens with jargon, an abbreviation or background instead of its purpose makes this not_met.",
      "Terms and abbreviations a newcomer would not know are explained or shown with an example on the page where they appear; list each unexplained term met, with the page it appeared on. If none was found, quote one term together with its on-page explanation, or state that no specialist terms were seen.",
      "Instructions can be followed by a newcomer without outside knowledge, each step saying what to do and where; quote any instruction that assumed prior knowledge, skipped a step or pointed to something not visible, with its page. If no instructions were seen on the visited pages, report that and mark this inconclusive.",
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

export const managedDefaultGoal = "Review the approved public pages from this persona's perspective using read-only browsing, and hunt for friction rather than confirming that the site works. Visit at least three different pages. For every issue quote the exact visible label, heading or sentence and name the page. If a link leaves the approved site, record its label and destination host and do not click it again. Do not submit forms, authenticate, enter sensitive data, purchase or change data. Report observed friction and limitations, not untested claims: a problem found is not_met with the specifics, and anything unobserved is inconclusive.";
export const managedDefaultCriteria = [
  "Each visited page makes its purpose and next step clear to this persona; quote the heading or sentence that does so for each page, and name any page where it was missing.",
  "Navigation labels led where they promised on at least three pages; name any label that did not, with the page it appeared on and where it led instead.",
  "No visited page showed an error, an empty state or a link that led nowhere; name any that did with the quoted text and its page. If fewer than three pages were visited, report that and mark this inconclusive.",
];

export function managedSpecialistForAssignment(assignment: Assignment) {
  const same = (preset: Assignment) => preset.personaId === assignment.personaId && preset.goal === assignment.goal
    && preset.criteria.length === assignment.criteria.length
    && preset.criteria.every((criterion, index) => criterion === assignment.criteria[index]);
  return managedSpecialists.find((specialist) => same(specialist)
    || managedIanaDemoAssignments.some((preset) => preset.personaId === specialist.personaId && same(preset)));
}
