export function redactSensitiveText(text, exactValues = []) {
  let redacted = text;
  for (const value of exactValues) {
    if (value.length >= 16) redacted = redacted.replaceAll(value, "[REDACTED]");
  }

  return redacted
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/([?&](?:access_token|refresh_token|token|token_hash)=)[^&\s]+/gi, "$1[REDACTED]");
}
