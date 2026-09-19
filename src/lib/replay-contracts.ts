/** Browser-safe contracts. Provider identifiers and signed URLs never belong here. */
export type ReplayStatus = "processing" | "unavailable" | "expired" | "unsupported" | "ready";

export type ReplayReport = {
  status: ReplayStatus;
  format: "hls";
  sensitive: true;
  fallback: "operator-dashboard";
  pages: {
    index: number;
    startTimeMs: number;
    endTimeMs: number;
    playlistPath: string;
  }[];
  retryAfterSeconds?: number;
};

export const REPLAY_POLLING = { intervalSeconds: 5, maxAttempts: 12 } as const;
