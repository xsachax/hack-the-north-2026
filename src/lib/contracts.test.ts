import { describe, expect, it } from "vitest";
import {
  assignmentSchema, attemptSchema, createRunSchema, newCreateRunSchema, eventSchema, evidenceSchema,
  findingSchema, idempotencyKeySchema, idSchema, jobSchema, paginationSchema,
  personaIdSchema, personaProfileSchema, personaSchema, runSchema, statusSchema,
  terminalStatusSchema, timestampSchema, usageReservationSchema,
} from "./contracts";
import { controlledRunSchema, newControlledRunSchema } from "./controlled-run";
import { demoRunSchema, newDemoRunSchema } from "./demo-run";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const time = "2026-09-19T06:00:00.000Z";
const profile = {
  name: "Careful reader",
  character: "Checks the details",
  device: "desktop",
  techComfort: "medium",
  patienceSteps: 10,
  readingStyle: "careful",
  quirks: ["Reads labels"],
  worries: ["Losing progress"],
};
const assignment = { personaId: "careful-reader", goal: "Find the help page", criteria: ["Help is visible"] };
const scope = { targetUrl: "https://example.com", allowedSubdomains: [], pathPrefixes: ["/"] };
const request = { authorizationAcknowledged: true, scope, assignments: [assignment] };
const run = {
  id, cursor: 1, status: "queued", authorizationAcknowledged: true, scope,
  createdAt: time, updatedAt: time, cancelRequestedAt: null,
};
const attempt = {
  id, runId: otherId, persona: { ...profile, id: "careful-reader" },
  goal: assignment.goal, criteria: assignment.criteria, status: "queued", createdAt: time, updatedAt: time,
};
const evidence = { id, runId: otherId, attemptId: id, kind: "observation", createdAt: time, summary: "Help link is hidden" };
const finding = {
  id, runId: otherId, attemptId: id, createdAt: time, title: "Hidden help",
  description: "The help link is hard to find", evidenceIds: [id],
};

describe("strict wire contracts", () => {
  it("rejects duplicate canonical criterion identities at admission", () => {
    const semantic = { id: "same", kind: "semantic", description: "First", semantics: "current" };
    for (const criteria of [
      ["duplicate", "duplicate"],
      [semantic, { ...semantic, description: "Different description" }],
      ["same", semantic],
    ]) {
      expect(assignmentSchema.safeParse({ ...assignment, criteria }).success).toBe(false);
    }
  });

  it("preserves historical duplicate string criteria when reading persisted attempts", () => {
    const criteria = ["Help is visible", "Help is visible"];
    expect(attemptSchema.parse({ ...attempt, criteria }).criteria).toEqual(criteria);
  });

  it.each([
    ["persona profile", personaProfileSchema, profile],
    ["persona", personaSchema, { ...profile, id: "careful-reader" }],
    ["assignment", assignmentSchema, assignment],
    ["create run", createRunSchema, request],
    ["run", runSchema, run],
    ["attempt", attemptSchema, attempt],
    ["event", eventSchema, { runId: id, sequence: 1, attemptId: null, timestamp: time, kind: "run.created", data: {} }],
    ["job", jobSchema, {
      id, runId: id, attemptId: id, status: "queued", leaseOwner: null,
      leaseExpiresAt: null, leaseGeneration: 0, cancelRequestedAt: null,
    }],
    ["reservation", usageReservationSchema, { jobId: id, reservedSeconds: 0, consumedSeconds: 0, releasedSeconds: 0 }],
    ["evidence", evidenceSchema, evidence],
    ["finding", findingSchema, finding],
    ["pagination", paginationSchema, { after: 0, limit: 1 }],
  ])("accepts %s but rejects unknown properties", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, ownerId: id }).success).toBe(false);
  });

  it("rejects unknown nested input and event properties", () => {
    for (const input of [
      { ...request, scope: { ...scope, ownerId: id } },
      { ...request, assignments: [{ ...assignment, status: "succeeded" }] },
    ]) expect(createRunSchema.safeParse(input).success).toBe(false);
    expect(attemptSchema.safeParse({ ...attempt, persona: { ...attempt.persona, ownerId: id } }).success).toBe(false);
    expect(eventSchema.safeParse({
      runId: id, sequence: 1, attemptId: null, timestamp: time, kind: "run.created", data: { secret: "not allowed" },
    }).success).toBe(false);
  });

  it.each([undefined, null, false, "true", 1])("requires explicit authorization, not %s", (authorizationAcknowledged) => {
    expect(createRunSchema.safeParse({ ...request, authorizationAcknowledged }).success).toBe(false);
  });

  it("retains one to twelve distinct persona assignments for historical hashes and replay", () => {
    const assignments = Array.from({ length: 12 }, (_, index) => ({ ...assignment, personaId: `persona-${index}` }));
    expect(createRunSchema.safeParse({ ...request, assignments }).success).toBe(true);
    for (const invalid of [[], [...assignments, { ...assignment, personaId: "thirteenth" }], [assignment, assignment]]) {
      expect(createRunSchema.safeParse({ ...request, assignments: invalid }).success).toBe(false);
    }
    expect(createRunSchema.safeParse({ ...request, assignments: [{ ...assignment, personaId: id }] }).success).toBe(true);
  });

  it.each([
    ["website", createRunSchema, newCreateRunSchema, request],
    ["demo", demoRunSchema, newDemoRunSchema, { authorizationAcknowledged: true, scenario: "fixed" }],
    ["controlled", controlledRunSchema, newControlledRunSchema, { authorizationAcknowledged: true, controlledSiteId: "store" }],
  ])("admits at most eight new %s assignments without rewriting historical payloads", (_mode, historical, admission, body) => {
    const assignments = Array.from({ length: 12 }, (_, index) => ({ ...assignment, personaId: `persona-${index}` }));
    const eight = { ...body, assignments: assignments.slice(0, 8) };
    expect(admission.parse(eight)).toEqual(historical.parse(eight));
    for (const count of [9, 12]) {
      const old = { ...body, assignments: assignments.slice(0, count) };
      expect(historical.parse(old).assignments).toHaveLength(count);
      expect(admission.safeParse(old).success).toBe(false);
    }
    expect(admission.safeParse({ ...body, assignments: [assignment, assignment] }).success).toBe(false);
    expect(admission.safeParse({ ...body, assignments: [] }).success).toBe(false);
  });

  it.each([
    ["name", 80], ["character", 1000],
  ] as const)("enforces trimmed nonempty %s and its length boundary", (field, maximum) => {
    expect(personaProfileSchema.parse({ ...profile, [field]: "  hello  " })[field]).toBe("hello");
    expect(personaProfileSchema.safeParse({ ...profile, [field]: "a".repeat(maximum) }).success).toBe(true);
    for (const value of ["", " \n\t ", "a".repeat(maximum + 1), "a\u0000b", "a\u007fb"]) {
      expect(personaProfileSchema.safeParse({ ...profile, [field]: value }).success).toBe(false);
    }
  });

  it.each(["quirks", "worries"] as const)("bounds %s count and item text", (field) => {
    expect(personaProfileSchema.safeParse({ ...profile, [field]: Array(12).fill("a".repeat(200)) }).success).toBe(true);
    for (const value of [[], Array(13).fill("valid"), [""], ["a".repeat(201)], ["bad\u0001text"]]) {
      expect(personaProfileSchema.safeParse({ ...profile, [field]: value }).success).toBe(false);
    }
  });

  it("bounds patience and disallows coercion and invalid persona enums", () => {
    for (const patienceSteps of [1, 30]) expect(personaProfileSchema.safeParse({ ...profile, patienceSteps }).success).toBe(true);
    for (const patienceSteps of [0, 31, 1.5, "10", NaN, Infinity]) {
      expect(personaProfileSchema.safeParse({ ...profile, patienceSteps }).success).toBe(false);
    }
    for (const invalid of [{ device: "tablet" }, { techComfort: "expert" }, { readingStyle: "fast" }]) {
      expect(personaProfileSchema.safeParse({ ...profile, ...invalid }).success).toBe(false);
    }
  });

  it("bounds assignment goals and criteria, including empty/control text", () => {
    expect(assignmentSchema.safeParse({
      ...assignment, goal: "a".repeat(2000),
      criteria: Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, "0")}${"a".repeat(498)}`),
    }).success).toBe(true);
    for (const goal of [" ", "a".repeat(2001), "bad\u0007text"]) {
      expect(assignmentSchema.safeParse({ ...assignment, goal }).success).toBe(false);
    }
    for (const criteria of [[], Array(13).fill("valid"), [""], ["a".repeat(501)], ["bad\u007ftext"]]) {
      expect(assignmentSchema.safeParse({ ...assignment, criteria }).success).toBe(false);
      expect(attemptSchema.safeParse({ ...attempt, criteria }).success).toBe(false);
    }
  });

  it("bounds evidence and finding text and evidence counts", () => {
    expect(evidenceSchema.safeParse({ ...evidence, summary: "a".repeat(1000) }).success).toBe(true);
    expect(findingSchema.safeParse({
      ...finding, title: "a".repeat(200), description: "a".repeat(2000), evidenceIds: Array(32).fill(id),
    }).success).toBe(true);
    for (const summary of ["", "a".repeat(1001), "bad\u0000text"]) {
      expect(evidenceSchema.safeParse({ ...evidence, summary }).success).toBe(false);
    }
    for (const invalid of [
      { title: "" }, { title: "a".repeat(201) }, { description: "" }, { description: "a".repeat(2001) },
      { evidenceIds: [] }, { evidenceIds: Array(33).fill(id) }, { evidenceIds: ["not-an-id"] },
    ]) expect(findingSchema.safeParse({ ...finding, ...invalid }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, kind: "arbitrary-file" }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, storageKey: "a".repeat(64) }).success).toBe(false);
  });

  it("validates identifiers, timestamps, statuses, and idempotency key boundaries", () => {
    expect(idSchema.parse(id)).toBe(id);
    expect(personaIdSchema.parse("a".repeat(64))).toHaveLength(64);
    for (const invalid of ["", "../persona", "UPPERCASE", "a".repeat(65)]) {
      expect(personaIdSchema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of ["persona", "../file", 1]) expect(idSchema.safeParse(invalid).success).toBe(false);
    expect(timestampSchema.parse(time)).toBe(time);
    for (const invalid of ["yesterday", "2026-09-19", 123]) expect(timestampSchema.safeParse(invalid).success).toBe(false);
    for (const status of statusSchema.options) {
      expect(terminalStatusSchema.safeParse(status).success).toBe(!["queued", "running"].includes(status));
    }
    expect(statusSchema.safeParse("failed").success).toBe(false);
    for (const length of [16, 128]) expect(idempotencyKeySchema.safeParse("a".repeat(length)).success).toBe(true);
    for (const invalid of ["a".repeat(15), "a".repeat(129), "abcdefghijklmnop/", "abcdefghijklmnop\n"]) {
      expect(idempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("defaults/coerces pagination but bounds its safe integer values", () => {
    expect(paginationSchema.parse({})).toEqual({ after: 0, limit: 50 });
    expect(paginationSchema.parse({ after: "10", limit: "100" })).toEqual({ after: 10, limit: 100 });
    expect(paginationSchema.parse({ after: Number.MAX_SAFE_INTEGER, limit: 1 }).after).toBe(Number.MAX_SAFE_INTEGER);
    for (const after of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "garbage"]) {
      expect(paginationSchema.safeParse({ after }).success).toBe(false);
    }
    for (const limit of [0, -1, 101, 1.5, Infinity, "garbage"]) {
      expect(paginationSchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it("requires positive event sequences and run cursors", () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(runSchema.safeParse({ ...run, cursor: value }).success).toBe(false);
      expect(eventSchema.safeParse({
        runId: id, sequence: value, attemptId: null, timestamp: time, kind: "run.created", data: {},
      }).success).toBe(false);
    }
  });

  it("rejects negative and fractional lease generations and usage counters", () => {
    for (const value of [-1, 0.5]) {
      expect(jobSchema.safeParse({
        id, runId: id, attemptId: id, status: "queued", leaseOwner: null,
        leaseExpiresAt: null, leaseGeneration: value, cancelRequestedAt: null,
      }).success).toBe(false);
      for (const field of ["reservedSeconds", "consumedSeconds", "releasedSeconds"]) {
        expect(usageReservationSchema.safeParse({
          jobId: id, reservedSeconds: 0, consumedSeconds: 0, releasedSeconds: 0, [field]: value,
        }).success).toBe(false);
      }
    }
  });
});
