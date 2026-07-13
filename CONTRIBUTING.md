# Contributing

Agency Workload is early in development. Discuss substantial behavior or architecture changes in an
issue before implementation.

## Local Checks

```bash
npm ci
npm run verify
```

Contributions must include tests for behavior changes, preserve the documented product boundary, and
introduce no telemetry or external service dependency without explicit review.

Never include secrets, production data, private URLs, customer files, or generated credentials in a
commit, issue, fixture, screenshot, or test recording.
