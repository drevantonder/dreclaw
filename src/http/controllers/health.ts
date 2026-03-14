export function handleHealthRequest(): Response {
  return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
}
