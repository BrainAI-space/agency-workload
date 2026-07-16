# Contributing

Agency Workload is early in development. Discuss substantial behavior or architecture changes in an
issue before implementation.

## Local Checks

```bash
npm ci
npm run verify
```

This is the public clean-clone gate. It needs no repository `.env`, private mirror file, or persistent
local service. Optional disposable Docker suites are documented in `docs/integration-tests.md` and
`docs/browser-smoke.md`; the canonical persistent setup is separate.

Contributions must include tests for behavior changes, preserve the documented product boundary, and
introduce no telemetry or external service dependency without explicit review.

Never include secrets, production data, private URLs, customer files, or generated credentials in a
commit, issue, fixture, screenshot, or test recording.

## Public Mirror Commands

The private `ai-gen-codes/agency-workload` repository is canonical. Only that exact origin may run
`npm run public:sync`; the command imports private-only allowlist tooling and writes the separately
checked-out public mirror. The public `BrainAI-space/agency-workload` origin refuses synchronization.

Both recognized origins support `npm run public:verify`. In the private canonical checkout it runs
the private mirror and local-secret checks. In the public checkout it validates only local files
against `.mirror-manifest.json`, including hashes, the managed source inventory, forbidden paths and
extensions, symlinks, and static secret signatures. Known dependency, build, coverage, and test-output
directories are excluded. It does not require `tools/public-files.json`, private scripts, a sibling
repository, or a private `.env`. Unrecognized origins fail closed.
