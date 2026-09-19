import { OwnerSession } from "@/components/owner-session";
import { RunReportView } from "@/components/run-report";

export default async function ReportsPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const single = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
  return <OwnerSession><RunReportView key={id} runId={id} selection={{
    attempt: single(query.attempt), group: single(query.group), evidence: single(query.evidence),
  }} /></OwnerSession>;
}
