import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitiveText } from "../lib/redact.mjs";

test("log redaction removes exact values, database credentials, JWTs, and URL tokens", () => {
  const exact = ["sensitive", "configuration", "value"].join("-");
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "signature"].join(".");
  const input = [
    exact,
    "postgresql://user:credential@database.invalid/example",
    jwt,
    "https://example.invalid/confirm?token_hash=token-material",
  ].join("\n");

  const output = redactSensitiveText(input, [exact]);

  assert.doesNotMatch(output, /sensitive|credential|eyJ|token-material/);
  assert.match(output, /REDACTED/);
});
