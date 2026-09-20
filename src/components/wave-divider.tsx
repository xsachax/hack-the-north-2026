export function WaveDivider() {
  return <svg className="wave-divider" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 22C100 58 160-8 280 18S470 58 600 20 820 4 1000 28V60H0Z" fill="var(--surf)" opacity=".65" />
    <path d="M0 38C140 4 230 62 390 36S620 4 760 34 920 54 1000 30V60H0Z" fill="var(--foam)" />
  </svg>;
}
