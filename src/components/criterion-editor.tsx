"use client";

import type { Criterion } from "@/lib/criteria";

type Structured = Exclude<Criterion, string>;
export function CriterionEditor({ criterion, onChange, onRemove }: {
  criterion: Structured; onChange: (value: Structured) => void; onRemove: () => void;
}) {
  return <div className="criterion">
    <div className="field-row">
      <label>Verify with<select value={criterion.kind} onChange={(event) => {
        const common = { id: criterion.id, description: criterion.description, semantics: criterion.semantics, paths: criterion.paths };
        switch (event.target.value) {
          case "url": onChange({ ...common, kind: "url", path: "/" }); break;
          case "visible_text": onChange({ ...common, kind: "visible_text", text: "", match: "contains" }); break;
          case "control": onChange({ ...common, kind: "control", label: "", match: "exact" }); break;
          case "semantic": onChange({ ...common, kind: "semantic" }); break;
        }
      }}><option value="visible_text">Visible text</option><option value="url">URL pathname</option><option value="control">Control state</option><option value="semantic">Semantic judgment</option></select></label>
      <label>When it counts<select value={criterion.semantics} onChange={(event) => onChange({ ...criterion, semantics: event.target.value === "milestone" ? "milestone" : "current" })}><option value="current">On the current page</option><option value="milestone">Milestone along the way</option></select></label>
    </div>
    <label>Success criterion<input required maxLength={500} value={criterion.description} onChange={(event) => onChange({ ...criterion, description: event.target.value })} /></label>
    {criterion.kind === "visible_text" && <label>Text to observe<input required maxLength={500} value={criterion.text} onChange={(event) => onChange({ ...criterion, text: event.target.value })} /></label>}
    {criterion.kind === "url" && <label>Exact pathname<input required value={criterion.path} onChange={(event) => onChange({ ...criterion, path: event.target.value })} placeholder="/project-board/projects" /></label>}
    {criterion.kind === "control" && <>
      <div className="field-row">
        <label>Visible control label<input required maxLength={200} value={criterion.label} onChange={(event) => onChange({ ...criterion, label: event.target.value })} /></label>
        <label>Control kind<select value={criterion.controlKind ?? ""} onChange={(event) => {
          const value = event.target.value;
          onChange({ ...criterion, controlKind: value === "link" || value === "button" || value === "input" || value === "select" ? value : undefined });
        }}><option value="">Any measured control</option>{["link", "button", "input", "select"].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <div className="field-row">{(["checked", "disabled"] as const).map((key) => <label key={key}>{key}<select value={criterion[key] === undefined ? "" : String(criterion[key])} onChange={(event) => onChange({ ...criterion, [key]: event.target.value === "" ? undefined : event.target.value === "true" })}><option value="">Do not assert</option><option value="true">Yes</option><option value="false">No</option></select></label>)}</div>
      <p className="muted">Optional exact values and selected option sets can be set in the per-persona canonical criteria editor below.</p>
    </>}
    {(criterion.kind === "visible_text" || criterion.kind === "control") && <label>Match<select value={criterion.match} onChange={(event) => onChange({ ...criterion, match: event.target.value === "exact" ? "exact" : "contains" })}><option value="contains">Contains literal text</option><option value="exact">Exact literal text</option></select></label>}
    {criterion.kind === "semantic" && <p className="notice">Uses the shared model-call budget. Semantic confidence is a heuristic, not a calibrated probability or proof.</p>}
    <label>Observable paths (optional, one per line)<textarea rows={2} value={criterion.paths?.join("\n") ?? ""} onChange={(event) => onChange({ ...criterion, paths: event.target.value ? event.target.value.split("\n") : undefined })} placeholder="Exact paths; this does not grant navigation access." /></label>
    <button type="button" className="text-button" onClick={onRemove}>Remove criterion</button>
  </div>;
}
