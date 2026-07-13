import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";

async function requireStatus(label, url, expected = 200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (response.status !== expected) throw new Error(`${label} returned an unexpected status`);
  return response;
}

async function checkSmtp() {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 1025 });
    const timeout = setTimeout(
      () => socket.destroy(new Error("SMTP health check timed out")),
      5_000,
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

try {
  await requireStatus("GoTrue health", "http://127.0.0.1:9999/health");
  await requireStatus("Mailpit UI", "http://127.0.0.1:8025/");
  await checkSmtp();

  const signupResponse = await fetch("http://127.0.0.1:9999/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `signup-probe-${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString("base64url"),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const signupBody = await signupResponse.text();
  if (
    signupResponse.ok ||
    !/signup(?:s)? (?:are )?not allowed|signup.*disabled/i.test(signupBody)
  ) {
    throw new Error("Public signup was not rejected with the expected disabled response");
  }

  console.log("GoTrue health endpoint: healthy.");
  console.log("Mailpit UI and SMTP: healthy.");
  console.log("Public signup: disabled.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Local service health check failed safely.",
  );
  process.exitCode = 1;
}
