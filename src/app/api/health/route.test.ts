import { expect, it } from "vitest";
import { GET } from "./route";

it("reports uncached process liveness without claiming worker or provider readiness", async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok", service: "flash-flood" });
});
