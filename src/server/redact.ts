export function safeErrorMessage(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof AggregateError
    ? `${error.message} ${error.errors.map((item) => safeErrorMessage(item, secrets)).join("; ")}`
    : error instanceof Error ? error.message : "Unknown error";

  let redacted = message;
  for (const secret of secrets.filter(Boolean)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/bb_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, "[REDACTED_URL]");
}
