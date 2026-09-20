"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { WaveDivider } from "./wave-divider";

export function OnboardingFrame({ steps, step, title, description, onStep, children, actions, navigationLocked = false }: {
  steps: readonly string[];
  step: number;
  title: string;
  description: string;
  onStep: (step: number) => void;
  children: ReactNode;
  actions?: ReactNode;
  navigationLocked?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef(step);
  useEffect(() => {
    if (previous.current !== step) {
      heading.current?.focus({ preventScroll: true });
      body.current?.scrollTo({ top: 0, behavior: "instant" });
      previous.current = step;
    }
  }, [step]);

  return <section className="onboarding-frame" aria-label="Run setup">
    <header className="onboarding-heading">
      <ol className="onboarding-progress" aria-label="Onboarding progress">
        {steps.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined}>
          <button type="button" disabled={navigationLocked || index >= step}
            onClick={() => onStep(index)} aria-label={`Back to ${label}`}>
            <span aria-hidden="true">{index + 1}</span><span>{label}</span>
          </button>
        </li>)}
      </ol>
      <p className="eyebrow">STEP {step + 1} OF {steps.length}</p>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      <p>{description}</p>
    </header>
    <div className="onboarding-body" ref={body}>{children}</div>
    {actions && <div className="onboarding-actions">{actions}</div>}
    <WaveDivider />
  </section>;
}
