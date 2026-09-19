export function GET() {
  return Response.json({ status: "ok", service: "flash-flood" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
