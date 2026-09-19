import { finalizeReleaseInspection } from "./release-integration";

if (process.argv.length !== 3) throw new Error("release_inspection_invocation_required");
await finalizeReleaseInspection(process.argv[2]);
console.log("Private release inspection finalized from unchanged evidence; no provider operations.");
