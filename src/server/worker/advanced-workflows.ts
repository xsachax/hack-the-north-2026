import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Repository } from "../repository";
import { ArtifactReader, getRawArtifactJson } from "../reports/artifacts";
import { ReproductionService } from "../workflows/reproduction";
import { workerPolicySchema } from "./config";
import { ServiceError } from "../errors";

export const advancedWorkerMigration = `
  CREATE TABLE reproduction_worker_jobs (
    candidate_id TEXT PRIMARY KEY REFERENCES reproduction_candidates(id),
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
  );
`;

export function reproductionService(
  db: DatabaseSync, repository: Repository, clock: () => number,
): ReproductionService {
  const row = db.prepare("SELECT configuration FROM worker_policy WHERE singleton=1").get();
  if (!row) throw new ServiceError("unavailable", 503);
  const policy = workerPolicySchema.parse(JSON.parse(z.string().parse(row.configuration)));
  const reader = new ArtifactReader({ dataDir: repository.dataDir });
  return new ReproductionService(db, {
    reservationSeconds: policy.sessionSeconds,
    limits: {
      candidates: 3, steps: 90, modelCalls: 0, durationMs: 240_000,
      candidateMs: 60_000, reservedSeconds: 3 * policy.sessionSeconds,
    },
    clock,
    loadSource(owner, runId) {
      const source = repository.reportSource(owner, runId);
      return {
        source,
        humanActions: source.humanAssistedAttemptIds === undefined || source.humanAssistedAttemptIds.length > 0,
        evidence: source.evidence.map((stored) => {
          const result = reader.read({
            evidence: stored.metadata, storageKey: stored.storageKey,
            runId: stored.metadata.runId, attemptId: stored.metadata.attemptId,
          });
          return {
            ...stored,
            state: result.status === "redacted" ? "unavailable" :
              result.status === "unavailable" && result.reason === "unsupported-kind" ? "unsupported" : result.status,
            data: getRawArtifactJson(result),
          };
        }),
      };
    },
  });
}
