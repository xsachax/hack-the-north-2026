import { createInterface } from "node:readline";
import { WorkerRepository } from "../repository";

// This fixture imports no cloud adapter and can only claim durable database work.
const [directory, policy, timestamp, workerId] = process.argv.slice(2);
const repository = new WorkerRepository(directory, JSON.parse(policy), () => Number(timestamp));
const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({ kind: "ready", pid: process.pid });
createInterface({ input: process.stdin }).on("line", (command) => {
  if (command === "claim") {
    send({ kind: "attempting" });
    try {
      send({ kind: "claimed", claim: repository.claim(workerId) });
    } catch (error) {
      send({ kind: "failed", error: String(error) });
      process.exitCode = 1;
    }
  } else if (command === "exit") {
    repository.close();
    process.exit(0);
  }
});
