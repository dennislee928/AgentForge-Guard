# AgentForge Guard — Assessment & Implementation Plan

## Context

The repo is empty apart from `LICENSE` (MIT), `.gitignore` (which ignores `/.ignore`) and `.gitattributes`. The spec is `.ignore/reference.txt`, a Chinese-language review of a hybrid AI-coding-sandbox architecture followed by a proposal to build it as an open-source tool, **AgentForge Guard (`afg`)**. `afg` is an agentic code-execution tool. Every command an agent wants to run goes through a single Rust policy engine. That engine decides allow, deny, require-approval or route, then runs the command on a local, Docker or (later) Cloudflare backend and writes a redacted audit record.

User decisions:
- **It is not an MCP server.** It is an agentic code-execution tool. Agents use it through `afg run` (managed mode) and through native agent hooks. MCP is dropped from the plan.
- **License:** dual MIT / Apache-2.0.
- **Scope:** every milestone is planned at task level.

Working rules for execution:
- **One commit per completed task**, as a Conventional Commit ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **A phase alignment check at the end of each phase.** Re-read `docs/plan.md`, tick the finished tasks, record any deviations or new risks in its "Alignment log", fix drift, then commit `docs(plan): align after phase N`.
- Work on a branch per milestone (`milestone/v0.1`, and so on) and fast-forward merge to `main` locally when the milestone passes its gate. Never push without asking.
- Use TDD. The workspace must build and all tests must pass after every task.

## Assessment of reference.txt

**Sound, keep:**
- Run deterministic development work locally, run untrusted code in a sandbox, and gate infrastructure changes behind approval.
- Use four trust tiers, T0–T3.
- "Prompt instructions are not a security boundary."
- Fail closed on unknown commands.
- Use structured argv and never run commands through an implicit shell.
- Have a single policy engine that every adapter shares.
- Separate managed mode from agent-integration mode, and be honest about the difference.
- Upload a manifest-filtered workspace to remote sandboxes.
- Test for TOCTOU (time-of-check to time-of-use) races.
- Treat test runners and build tools as arbitrary code execution.

**Issues to correct in the plan:**
1. **Roadmaps conflict.** §6 makes v0.2 "agent integration" and v0.3 "Cloudflare". The language section makes v0.2 "Zig" and v0.4 "Mojo", and puts a TypeScript MCP server in v0.1. This plan merges them into one ordering (below) and drops MCP.
2. **The repo layout has duplicates:** `afg-mcp` (Rust) and `packages/mcp-server` (TS). Both are dropped. TypeScript is kept only for the Cloudflare adapter and generated policy types.
3. **The sample policy's `read-only` rule is unsafe as written.** A plain argv-prefix match on `["git","diff"]` also allows `git diff --ext-diff`, `git -c diff.external=… diff` and `--output=…`, and each of these can run code or write files. Rules therefore need argument constraints (`denyArgs` and `allowFlags`), and global options such as `git -c` or `--git-dir` must be normalized before matching.
4. **Approval semantics are underspecified.** If an agent can answer the approval prompt, the approval is meaningless. Approval must come from a human-controlled channel: the controlling TTY, or a signed one-time token. With no TTY, the command is denied.
5. **Some claims were unverified as of 2026-11-19 and must be checked at implementation time, not trusted:**
   - Cloudflare Sandbox SDK "1.0" and its API.
   - The exact Codex config keys.
   - The JSON contract for Claude Code hooks.
   The plan pins versions and re-reads the official docs in the task that uses each one.
6. **Toolchain gaps on this machine.** Go and Zig are not installed; Rust 1.99, Docker 29, Node 24 and pnpm 9 are. Tests that need Go or Zig use detection fixtures, and live toolchain tests are `#[ignore]`d unless the tool is present. CI installs both.
7. **License.** The repo is MIT and the reference recommends Apache-2.0. Resolved to dual licensing.

## Architecture (fixed decisions)

- **Rust workspace crates:**
  - `afg-core`: policy schema, normalizer, evaluator, decision types.
  - `afg-detect`: stack and agent detection.
  - `afg-executor`: the `Executor` trait plus the `local` and `docker` backends.
  - `afg-report`: audit JSONL, redaction, SARIF.
  - `afg-cli`: the `afg` binary, using clap and tokio.
- **TypeScript (`packages/`)** exists only from v0.4: `policy-types` (generated from JSON Schema) and `cloudflare-adapter`.
- **Evaluation pipeline:**
  1. Parse the request into `ExecutionRequest { argv, cwd, env_allowlist, timeout, limits, network, snapshot }`.
  2. **Normalize:**
     - Resolve the executable to an absolute path and canonicalize it.
     - Unwrap known wrappers: `env`, `command`, `exec`, `nice`, `nohup`, `timeout`, `sudo` (sudo → deny).
     - Detect shell interpreters (`sh`, `bash`, `zsh`, `-c`) and treat them as opaque.
     - Detect `xargs`, `find -exec` and `make` as indirect execution, and treat them as opaque.
  3. **Protected-path check.** Any argument or cwd that canonically resolves, following symlinks, into a protected path is denied. Protected paths are `~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gcloud`, `.env*`, `*.pem`, `id_*` and the docker socket.
  4. **Rule match.** The precedence is deny > require-approval > route > allow. Anything unmatched or opaque falls to `execution.fallback`, which defaults to `deny`; a policy can set it to `route: container`.
  5. Return a `Decision { effect, backend, rule_id, reasons[], policy_hash }`.
- **TOCTOU defenses:**
  - The executor runs the resolved absolute path, not `$PATH` lookup.
  - Script files named in argv are hashed at check time and re-verified immediately before execution.
  - Docker runs against a copied snapshot directory, not the live tree.
- **Docker backend:** it runs `docker run` with a structured argv. The flags are:
  - `--rm`, `--network none` (by default), `--read-only`, `--tmpfs /tmp`.
  - `--memory`, `--cpus` and `--pids-limit` from the policy.
  - `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user <uid>:<gid>`.
  - An env allowlist only.
  - Never a docker socket or a `$HOME` mount.
  - The snapshot is built from a manifest that excludes secrets and `.gitignore`d files, and is bind-mounted.
- **Audit:** append-only JSONL in `.agentforge/audit/`. Each record holds:
  - argv, cwd, the policy version and hash, the decision, the backend, the exit code, the duration and the output digests.
  - Secrets redacted: env values are always redacted, and token, key and PEM patterns are scrubbed from argv and output excerpts.

## Milestone v0.1 — CLI + Policy Engine + Docker Sandbox

### Phase 0 — Foundations
- [x] **T0.1** Add `LICENSE-MIT` (moved from `LICENSE`) and `LICENSE-APACHE`, and set `license = "MIT OR Apache-2.0"` in the README section and in Cargo.
- [x] **T0.2** Copy this plan into `docs/plan.md`, with checkboxes and an empty Alignment log. This file is the tracked source of truth for alignment checks.
- [x] **T0.3** Write the ADRs in `docs/adr/`:
  - 0001 Rust core.
  - 0002 Single policy engine.
  - 0003 Fail-closed normalization.
  - 0004 Docker via CLI argv, no socket mounts.
  - 0005 No MCP; managed mode plus hooks.
  - 0006 Dual license.
- [x] **T0.4** Write `docs/threat-model.md` (trust tiers T0–T3, attacker = the agent or the code it generated, assets, bypass classes) and `docs/security-boundaries.md`, which spells out managed mode versus integration mode.
- [x] **T0.5** Create the Cargo workspace skeleton with the five crates. Add `rust-toolchain.toml`, `rustfmt.toml`, `deny.toml`, and update `.gitignore` to cover `target/` and `.agentforge/audit/`.
- [x] **T0.6** Write `CLAUDE.md` and `AGENTS.md` for contributors: the TDD rule, the Definition of Done commands, and "never weaken a deny test".
- [x] **T0.7** Add `.github/workflows/ci.yml`, which runs fmt, clippy with `-D warnings`, test and cargo-deny on Linux and macOS.
- **Gate:** `cargo build` and `cargo test --workspace` pass with zero tests. Run the alignment check.

### Phase 1 — Policy schema & evaluator (`afg-core`)
- [x] **T1.1** Write the v1alpha1 serde types with `deny_unknown_fields`. They cover the reference schema plus the `denyArgs`/`allowFlags` rule constraints and `protectedPaths`.
- [x] **T1.2** Generate `agentforge.schema.json` with `schemars`. A test checks that the committed schema matches the generated one.
- [x] **T1.3** Write the semantic validator: duplicate rule ids, unknown backends, a `route` rule with no backend, and a disabled backend being referenced.
- [x] **T1.4** Write the normalizer: executable resolution, wrapper unwrapping, shell/indirect opacity, and `git` global-option handling.
- [x] **T1.5** Write the protected-path checker, which uses canonicalization and resolves symlinks.
- [x] **T1.6** Write the evaluator, covering precedence, fallback and the `Decision` reasons.
- [x] **T1.7** Ship the built-in `policies/default.yaml`, `strict.yaml` and `ci.yaml`.
- [x] **T1.8** Add the fixture suite `tests/policy-fixtures/*.yaml`, as triples of (policy, argv, expected decision), plus a table-driven runner. Future adapters must also pass these as conformance tests.
- [x] **T1.9** Write the adversarial suite `tests/adversarial/`. It covers:
  - `bash -c`, `env sh`, nested shells.
  - `$(…)` and backtick substitution inside args.
  - `git -c`, `--ext-diff`.
  - `../` traversal and a symlink pointing to a fake `~/.ssh`.
  - `make deploy`, `xargs`.
  - Unicode and whitespace tricks in argv.

  Each case must end in deny or route.
- **Gate:** all fixtures pass. Run the alignment check.

### Phase 2 — Detection (`afg-detect`)
- [x] **T2.1** Write the `Detector` trait and the Go detector (`go.mod`, `go.work`), which suggests `go vet ./...` and `go test ./...`.
- [x] **T2.2** Write the Rust detector (`Cargo.toml`, with workspaces).
- [x] **T2.3** Write the Node/TS/Next.js detector:
  - Inputs: `package.json`, `tsconfig.json`, `next.config.*`, and the package manager from its lockfile.
  - It suggests the scripts the project defines.
  - It marks `install` as T2, so that step runs in a container.
- [x] **T2.4** Write the agent detector: `CLAUDE.md`, `.claude/`, `AGENTS.md`, `.codex/`.
- [x] **T2.5** Write the risk detector, which flags committed `.env` files, a kubeconfig in the repo, terraform state, and CI scripts.
- [x] **T2.6** Add fixture repos under `tests/language-detection/`. They are monorepos with nested projects.
- **Gate:** run the alignment check.

### Phase 3 — Executors (`afg-executor`)
- [x] **T3.1** Write the `Executor` trait (`execute` and `cleanup`), along with `ExecutionRequest`, `ExecutionResult` and `ExecutionError`.
- [x] **T3.2** Write the local executor:
  - No shell; it runs `Command::new(abs_path)`.
  - The environment is cleared, then only allowlisted variables are passed.
  - It enforces the timeout and kills the whole process group.
  - It captures and streams output.
- [x] **T3.3** Write the snapshot builder: it builds a manifest from git-tracked files minus protected patterns, copies them to a temp dir, and records the manifest hash.
- [x] **T3.4** Write the Docker executor, which builds the argv as specified in Architecture and checks that Docker is available.
- [x] **T3.5** Add TOCTOU re-verification: script hashes and executable identity are re-checked immediately before spawning.
- [x] **T3.6** Write isolation tests in `tests/sandbox-isolation/`. Each one is `#[ignore]` unless Docker is present.
  - A fake host `.env` and a fake `~/.ssh` key are unreadable from inside the container.
  - Network egress fails.
  - Writing to the root filesystem fails.
  - The memory limit OOM-kills the process.
  - The timeout kills the process.
  - The docker socket is absent.
- **Gate:** run the alignment check.

### Phase 4 — Audit & redaction (`afg-report`)
- [x] **T4.1** Write the audit record type and the JSONL writer, which uses append mode and file locking.
- [x] **T4.2** Write the redactor. It removes env values and scrubs these patterns:
  - AWS, GitHub and Slack tokens.
  - JWTs.
  - PEM blocks.
  - `key=` and `token=` assignments.

  Add property tests that check redacted output never contains seeded secrets.
- **Gate:** run the alignment check.

### Phase 5 — CLI (`afg-cli`)
- [x] **T5.1** Write `afg init`. It writes `agentforge.yaml` from the detection results and the default policy. It never downloads or runs anything, and it refuses to overwrite an existing file without `--force`.
- [x] **T5.2** Write `afg doctor`: the detected stacks and agents, risks, backend availability, and validation of the policy. It supports `--json`.
- [x] **T5.3** Write `afg policy explain -- <argv>` (decision, matched rule, reasons) and `afg policy validate`.
- [x] **T5.4** Write `afg run [--isolation local|container] -- <argv>`. It goes evaluate → approval → route → execute → audit. Its exit code passes through, and denials use exit code 126.
- [x] **T5.5** Write the approval flow. It prompts on `/dev/tty` with the exact argv, cwd and backend. With no TTY, the command is denied. It never reads the approval from stdin.
- [x] **T5.6** Write `afg audit tail` and `afg audit show <id>`.
- [x] **T5.7** Write CLI integration tests with `assert_cmd`. They cover the full flow `init → doctor → run → audit` on a temp repo.
- **Gate:** run the alignment check.

### Phase 6 — Examples, docs, release gate
- [x] **T6.1** Build `examples/polyglot-monorepo`: a Go API, a Rust service and a Next.js app, plus a committed sample `agentforge.yaml`.
- [x] **T6.2** Add CI demo jobs:
  - (a) `terraform destroy` is denied, and the job asserts the audit record.
  - (b) An untrusted script run in Docker cannot read the host's fake credentials or reach the network.
- [x] **T6.3** Write the README (quickstart, managed vs. integration mode, the honest limitations section) and `docs/policy-reference.md`.
- [x] **T6.4** Add `CONTRIBUTING.md`, `SECURITY.md` and the issue templates.
- **Gate (v0.1 DoD):** fmt, clippy with `-D warnings`, and `cargo test --workspace` all pass. The deny and isolation tests pass, with isolation run on Linux CI. No secrets appear in the audit logs. The quickstart works from a clean checkout. Then run the alignment check, merge to `main`, and tag `v0.1.0` locally.

## Milestone v0.2 — Agent Integration & Reporting

The Claude Code hook JSON contract and the Codex config keys must be verified against the current official docs when these tasks start.

### Phase 7 — Claude Code adapter (`adapters/claude/`)
- [x] **T7.1** Write `afg hook claude-pretool`. It reads the PreToolUse JSON from stdin, evaluates `Bash` commands with the same engine, and returns allow, deny or ask. Opaque shell strings are tokenized conservatively, and anything ambiguous returns deny or ask.
- [x] **T7.2** Write the PostToolUse formatter hook, which runs after an Edit or Write operation. It is documented as running after that tool operation, not as an "onSave" event.
- [x] **T7.3** Write `afg agents sync claude`. It generates the `.claude/settings.json` permission rules (allow/ask/deny, plus Read deny rules for protected paths) and the hook registration, and inserts a `CLAUDE.md` section between markers. The command is idempotent.
- [x] **T7.4** Add out-of-band approval tokens. `afg run` prints a pending decision id, and `afg approve <id>` (run by a human in another terminal) writes a signed, single-use token bound to the decision hash and argv. This closes the PTY approval gap found in Phase 5.
### Phase 8 — Codex adapter (`adapters/codex/`)
- [x] **T8.1** Write `afg agents sync codex`. It inserts an `AGENTS.md` section between markers and generates recommended `.codex/config.toml` sandbox and approval settings as guidance.
- [x] **T8.2** Check that `CLAUDE.md` and `AGENTS.md` are generated from one template, with a snapshot test.
### Phase 9 — Reporting & CI
- [x] **T9.1** Write `afg audit report --format json|sarif`. Denied and approval-gated events map to SARIF results.
- [x] **T9.2** Build a composite GitHub Action, `action.yml`, that runs `afg doctor` and `afg policy validate` and uploads the SARIF.
- [x] **T9.3** Write conformance tests that check the hook decisions equal the `afg policy explain` decisions across every fixture.
- **Gate:** run the alignment check and tag `v0.2.0`.

## Milestone v0.3 — Language Profiles (Zig, data-driven detection)

- [x] **T10.1** Move the hard-coded detectors to data-driven `language-profiles/*.yaml` files, which hold markers, verification commands and their tiers. The existing tests must stay green.
- [x] **T10.2** Add a Zig profile (`build.zig`, `build.zig.zon` → `zig build`, `zig build test`) and a Zig version check.
- [x] **T10.3** Add a Python profile, which is needed before Mojo. `pip install` is T2.
- [x] **T10.4** Add a Mojo profile, covering detection and a build command only.
- [x] **T10.5** Add Go and Zig to the CI matrix, which un-ignores the live toolchain tests. Add `examples/zig-project`.
- **Gate:** run the alignment check and tag `v0.3.0`.

## Milestone v0.4 — Cloudflare Sandbox Backend (TypeScript)

- [x] **T11.1** Add the pnpm workspace and `packages/policy-types`, which generates TS types from `agentforge.schema.json`. CI fails if the generated types drift from the schema.
- [x] **T11.2** Write `packages/cloudflare-adapter`, a Worker plus Sandbox SDK. Pin the SDK major version after re-reading the current docs. It exposes an authenticated execute endpoint that accepts only pre-approved `ExecutionRequest`s, signed by the CLI with a per-project key. It makes no policy decisions itself.
- [x] **T11.3** Write the Rust `CloudflareExecutor`. It uploads the manifest-filtered snapshot, runs the command, downloads the result, and cleans up the session.
- [x] **T11.4** Add lifecycle controls: session TTL, cost and timeout caps, and guaranteed cleanup when a run fails.
- [x] **T11.5** Add tests:
  - A mocked Worker that checks the contract.
  - An opt-in live test that needs `CF_*` env vars.
  - A test proving that protected files never appear in the upload manifest.
- [x] **T11.6** Write `docs/provider-compatibility.md`, covering the CI fidelity limits: OIDC, privileged Docker and service containers.
- **Gate:** run the alignment check and tag `v0.4.0`.

## Milestone v0.5 — Optional Native Helper & Mojo Plugin (experimental, gated)

- [x] **T12.1** Build a benchmark and profiling harness for policy evaluation and executor overhead.
- [-] **T12.2** *(skipped per ADR 0007: benchmarks show no need)* Build the Zig native helper (`native/zig-helper`) **only if** T12.1 or a platform feature (process telemetry, C ABI) justifies it. It is a separate optional binary and makes no policy decisions.
- [-] **T12.3** *(skipped per ADR 0007: benchmarks show no need)* Build `plugins/mojo-compute` as an experimental, separately installed plugin for log and telemetry analysis. It runs through an authorized executor and gets no extra privileges.
- **Gate:** run the alignment check. If T12.1 shows no need, record that decision in an ADR and skip T12.2/T12.3.

## Milestone v1.0 — Stable

- [x] **T13.1** Add fuzzing of the normalizer and policy parser (`cargo-fuzz`) and run it in a scheduled CI job.
- [~] **T13.2** *(internal red-team review done, with 4 findings fixed and regression-tested; an independent external review is still pending and is a v1.0 release blocker)* Have someone review the threat model, and add a regression test for every bypass found.
- [x] **T13.3** Add a supply-chain workflow (`security.yml`): cargo-audit, cargo-deny, OSV, CodeQL, Dependabot.
- [x] **T13.4** Add a release workflow (`release.yml`). It builds binaries for macOS arm64/x64, Linux x64/arm64 and Windows x64, and produces an SBOM (CycloneDX), cosign signing and SLSA provenance. It also publishes to crates.io, after checking that the name is free.
- [x] **T13.5** Mark the policy schema `v1`, with a migration from `v1alpha1` (`afg policy migrate`).
- [x] **T13.6** Run a documentation pass and set up a Homebrew tap.
- **Gate:** run the alignment check and tag `v1.0.0`. Never claim production readiness without green isolation and bypass suites.

## Milestone v1.0 — Distribution

Users install a released binary without cloning the repository. Go users use the install script: Go's registry builds only Go source, and a Go wrapper that downloads a Rust binary was rejected as fragile.

- [x] **T14.1** Point every repository, homepage, SARIF `helpUri` and Homebrew URL at `github.com/dennislee928/AgentForge-Guard`, and the tap at `dennislee928/homebrew-tap`.
- [x] **T14.2** Add the npm package `agentforge-guard` (`npm i -g agentforge-guard`, `npx agentforge-guard`). A small launcher runs the binary from the matching optional per-platform package (`agentforge-guard-<os>-<cpu>`); it never downloads at install time and runs no install scripts. Test the platform resolution.
- [x] **T14.3** Add `install.sh`. It picks the release archive for the OS and CPU, verifies it against `SHA256SUMS` (and the cosign bundle when `cosign` is installed), and installs `afg` into a user directory. It fails closed on any mismatch. Test it against a local fake release.
- [x] **T14.4** Release workflow: publish the npm packages with provenance (prereleases under the `next` dist-tag), attach `install.sh`, and skip each registry when its token is missing. Update the README install section.
- [x] **T14.5** npm package metadata for supply-chain scanners (Socket.dev): every platform package ships a README that names its target and explains how to verify the binary (provenance, `SHA256SUMS`, Sigstore); all manifests carry `keywords`, `author` and `bugs`. Released as `1.0.0-rc.2`.
- [x] **T14.6** Release binary size: a `[profile.release]` with `strip = "symbols"`, fat LTO and one codegen unit. On macOS arm64 `afg` shrank from 8.54 MB to 5.06 MB (-41%). Panic stays `unwind` so Drop-based cleanup still runs. Released as `1.0.0-rc.3`.
- [x] **T14.7** npm license and entry point. The npm packages are MIT only, with one `LICENSE` file; the source and crates stay MIT OR Apache-2.0. Each platform package has an `index.js` that exports its binary path. Released as `1.0.0-rc.4`.
- [x] **T14.8** Separate Socket scanner findings from packaging defects. Record the six `1.0.0-rc.4` package reports and explain the native-package `trivialPackage` classification and score limitations. Correct the platform README's contents and verification instructions; test actual npm tarballs for complete contents, matching binary bytes, resolvable entry points, exact dependency pins and absence of lifecycle scripts. Keep the minimal wrapper; do not add code or suppress findings to raise a score. Evidence and verification: `docs/npm-package-security.md` and `docs/npm-socket-rc.4.json`.
- [x] **T14.9** Prepare `1.0.0-rc.5` from the merged packaging fixes: bump workspace, lockfile and install examples, and pass local release checks. Keep prerelease status until the independent security review is complete. Local fmt, clippy, 187 Rust tests, cargo-deny, 10 npm tests and verification of all five packaged crates passed.
- [x] **T14.10** Publish `1.0.0-rc.5`: pass CI gates, tag the verified release commit, and confirm signed GitHub artifacts plus all six npm packages and crates.io publication. Released from `b9fcb84`; [release workflow 44988317340](https://github.com/dennislee928/AgentForge-Guard/actions/runs/44988317340) passed. All six npm signatures and attestations verified, all five crates confirmed published and not yanked, all five npm binaries matched their attested GitHub archives, release checksums passed, and the installed launcher reported `afg 1.0.0-rc.5`.
- [x] **T14.11** Act on rc.5 Socket component metrics: ship runnable tests in all six npm artifacts, document platform installation and troubleshooting, and verify binary hashes and package identity before the launcher spawns them. Preserve the path-string platform API, fail closed for corrupted/missing/mismatched metadata and binaries, and test the published tarballs. Record measurable quality gaps separately from adoption, prerelease status and scanner limitations; no artificial downloads, code padding or scanner exclusions. Baseline: `docs/npm-socket-rc.5.json`; interpretation and pending release limits: `docs/npm-package-security.md`. All 18 packaging tests and six real-binary preview self-test suites passed.

- [x] **T14.12** Prepare `1.0.0-rc.6`: update workspace, lockfile and installation examples for the merged integrity/test improvements, preserve release-candidate status, and pass local release checks. Fmt, clippy, 187 Rust tests, cargo-deny, 18 npm tests and verification of all five packaged crates passed.
- [ ] **T14.13** Publish `1.0.0-rc.6`: tag the exact commit after CI and Security pass; verify GitHub artifacts, npm signatures/attestations, package self-tests, host launcher version and crates.io publication. Request fresh Socket package reports after publication and distinguish pending scans from completed findings.

## Milestone v1.1 — Security Validation & Adoption

Goal: every security claim maps to a reproducible test, a CI result and a stated security boundary, and is not only a demo. Ordered by priority.

| Priority | Task | Outcome |
|---|---|---|
| P0 | T15.1 Security Validation Matrix in CI | Each scenario below has a named test that runs on every PR and is reported as a table |
| P0 | T15.2 Reproducible isolation attack/defense matrix | Attacks run against afg and the sandbox in CI, with expected denials recorded |
| P0 | T15.3 Independent security review and policy-bypass testing | External reviewer report; every finding becomes an adversarial fixture |
| P1 | T15.4 Every release artifact installs and verifies | Post-release CI installs from npm, crates.io and install.sh, and verifies SHA256SUMS, cosign and SLSA provenance |
| P1 | T15.5 3–5 external developers test and file issues | Tester guide, issue templates (bug, bypass report), feedback triaged |
| P2 | T15.6 Real adoption dashboard | Scheduled job records npm, crates.io and release downloads, plus stars and issues |

### Security Validation Matrix

| # | Scenario | Expected | Existing test (reproducible) | CI job | Security boundary |
|---|---|---|---|---|---|
| 1 | Read `.env` or an SSH private key | Deny | `tests/adversarial/bypass.yaml` (builtin:protected-path) via `afg-core` `adversarial_cases_never_allow`; `afg-cli` `cli.rs` hook cases `cat .env` and Read `.env` | CI `test` | Policy engine (managed mode); in integration mode only what the agent sends to the hook |
| 2 | Reach a protected path through a symlink | Deny | `bypass.yaml` `cat innocent.txt` → symlink to `~/.ssh/id_ed25519` (`policy_fixtures.rs`) | CI `test` | Path canonicalisation before matching |
| 3 | Policy edited but not re-trusted | Deny | `cli.rs` `edited_policy_is_untrusted_until_a_human_re_trusts_it` | CI `test`, `demos` | Trust pin (hash) of the reviewed policy |
| 4 | Run an untrusted shell script | Route to sandbox | `cli.rs` `untrusted_script_runs_in_container_without_host_secrets_or_network`; `scripts/ci-demos.sh` demo 3 | CI `demos` (Docker) | Docker sandbox: copied workspace, no secrets, no network |
| 5 | Agent runs `terraform destroy` | Deny | `cli.rs` `terraform_destroy_is_denied_with_audit_evidence`; `ci-demos.sh` demo 2 | CI `test`, `demos` | Policy rule `destructive-operations`, audited |
| 6 | `kubectl apply` without human approval | Deny / require approval | `cli.rs` `approval_without_a_terminal_is_refused`, `out_of_band_approval_tokens` | CI `test` | Approval from the controlling TTY or a single-use `afg approve` token bound to the argv |
| 7 | Verified script modified before execution | TOCTOU detection | `afg-executor` `sandbox_isolation.rs` `swapped_script_is_rejected_before_the_container_starts` | CI `test -- --ignored` (Docker) | Pinned hashes re-checked just before exec |
| 8 | Container tries to reach the network | Network blocked | `sandbox_isolation.rs` `no_network`; `cli.rs` scenario 4 | CI `test -- --ignored`, `demos` | `docker run --network none` |

- [ ] **T15.1** Matrix as code: `docs/security-validation-matrix.md` generated from a list of scenario → test name, and a CI job that runs exactly those tests (`cargo test <name>`, including the `--ignored` Docker ones) and fails if any named test is missing, skipped or renamed. The job summary shows the table with ✅/❌ and the commit SHA.
- [ ] **T15.2** Close matrix gaps with new adversarial cases, each written as a failing test first:
  - TOCTOU on the **local** backend, not only Docker.
  - `kubectl apply` approved on a TTY versus refused without one.
  - Symlink and hard-link races during a run.
  - Network egress over DNS and IPv6 inside the container.
  - Protected paths reached through `/proc/self/root` or `..` traversal.
  - Env-var smuggling (`env X=1`, `BASH_ENV`).
  - The hook seeing a different command than the one that runs.
- [ ] **T15.3** Independent review:
  - Scope document listing the threat model, the matrix and known limitations.
  - Engage a reviewer and record the report in `docs/security-review/`.
  - Each finding becomes a fixture in `tests/adversarial/` plus a fix, and `SECURITY.md` is updated.
  - This review gates **v1.0.0** (not an rc).
- [ ] **T15.4** `verify-release.yml` (on `release: published` and weekly):
  - On a matrix of macOS arm64 and x64, Linux x64 and arm64, and Windows: `npm i -g agentforge-guard@<v>`, `cargo install agentforge-guard --version <v>`, and `install.sh` with `AFG_REQUIRE_COSIGN=1`.
  - `cosign verify-blob` on every archive, `gh attestation verify` for SLSA, and `npm audit signatures`.
- [ ] **T15.5** External testing:
  - `docs/testing-guide.md`, a 15-minute task list covering the 8 matrix scenarios on the tester's own repo.
  - `.github/ISSUE_TEMPLATE/` with bug, bypass-report and feedback templates.
  - Recruit 3–5 developers and track them in a pinned issue.
- [ ] **T15.6** Adoption dashboard: a scheduled workflow appends npm, crates.io and GitHub-release download counts, stars, issues and external PRs to `metrics/adoption.jsonl` and renders a chart page. Real numbers only, no vanity metrics.

## Milestone — n8n Community Integration

User scope (2026-11-25): complete MVP, distribution and adoption; commit each
finished task, align after each phase, and verify public badge evidence. External
indexing, verification and adoption remain unchecked until independently observed.
The existing T15 security work and stable-release review gate remain in force.

### Phase 16 — MVP
- [x] **T16.1** Define the HTTP evaluation contract and security boundary against the existing Rust engine; add this roadmap.
- [x] **T16.2** Implement an authenticated, bounded, evaluation-only Rust HTTP gateway using `afg-core`; test allow, deny, approval, route, malformed input, trust changes and shared-fixture conformance. Never execute submitted commands.
- [x] **T16.3** Create `packages/n8n-nodes-agentforge-guard` using the official node tooling and metadata, credentials, Policy Evaluate, Command Analyze and Security Validate; enforce transport/schema failures without fabricating an allow result.
- [x] **T16.4** Add unit/integration and package-artifact tests, CI checks and real self-hosted n8n installation/execution verification.
  - [x] **T16.4a** Unit, real HTTP/Rust and exact artifact tests, plus a pinned-runtime CI gate.
  - [x] **T16.4b** Observe the real n8n runtime and Linux isolation gate passing in CI (Docker Desktop is unavailable locally). Run `45641771911` passed with n8n 2.49.6.
- [x] **T16.5** Add documented example workflows and gateway setup, including allow/deny branches and failure behavior.
- [x] **T16.6** Repair the pre-existing pnpm lockfile drift and assess development-tool advisories; apply compatible fixes or record explicit owner acceptance, preserving the security scan and build/lint/runtime compatibility. See `docs/n8n-release-risk.md` and the full advisory JSON.
- **Gate:** Rust DoD, node build/lint/tests, packed artifact checks and self-hosted n8n smoke test; then alignment commit.

### Phase 17 — Distribution
- [ ] **T17.1** Add a separate, version-checked GitHub Actions release workflow with npm provenance; publish and verify `n8n-nodes-agentforge-guard@0.1.0`.
  - [x] **T17.1a** Separate tag/version check, full runtime release gate, provenance and GitHub release automation. Includes retained audit/digest artifacts and manual deprecation rollback.
  - [ ] **T17.1b** Publish the integration tag after all gates pass; verify registry metadata and provenance.
- [ ] **T17.2** Verify installation and execution of the published artifact in self-hosted n8n.
- [ ] **T17.3** Confirm the actual NCNodes package page and record timestamped evidence.
- [ ] **T17.4** Confirm the actual WorkflowNodes package page and record timestamped evidence; Growing is a separate metric.
- [ ] **T17.5** Verify npm/crates.io versions and Community Node metadata; add only independently verified README badges.
- **Gate:** public artifacts, runtime installation and both directory pages observed; then alignment commit. A pending indexer keeps the corresponding task open.

### Phase 18 — Adoption
- [ ] **T18.1** Submit for official n8n verification and record the submission/outcome; Verified badge only after acceptance.
- [ ] **T18.2** Publish AI agent security workflow templates with reproducible usage instructions.
- [ ] **T18.3** Integrate JEF incident handling using its actual supported contract and verify a complete example flow.
- [ ] **T18.4** Track real npm adoption and third-party usage with reproducible observations; no synthetic downloads.
- **Gate:** recorded submission, templates, tested JEF integration and real adoption evidence; then alignment commit. An external review is not an agent-completable certification.

## Verification

- **Every task:** `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.
- **Docker isolation:** `cargo test --workspace -- --ignored` runs locally. Docker 29 is present.
- **End-to-end (v0.1):** in a temp copy of `examples/polyglot-monorepo`:
  1. Run `afg init`.
  2. Run `afg doctor --json` and check that it lists Go, Rust and Next.js.
  3. Run `afg run -- cargo check`, which should be allowed and run locally.
  4. Run `afg run -- terraform destroy`, which should be denied with exit code 126 and leave an audit record.
  5. Run `afg run --isolation container -- sh ./untrusted.sh`, which should fail to read the fake creds and the network.
  6. Run `afg audit tail` and check that it shows redacted records.
- **v0.2:** pipe sample PreToolUse JSON into `afg hook claude-pretool` and compare the result with `afg policy explain`.
- **v0.4:** run the contract tests against the mocked Worker, plus the opt-in live run.

## Alignment log

- 2026-11-19 — T0.1: `license` field in Cargo deferred to T0.5 (no `Cargo.toml` exists yet). LICENSE-APACHE uses the standard terms-only text (as in serde).
- 2026-11-19 — **Phase 0 aligned.** Gate passed (build, fmt, clippy `-D warnings`, test, cargo-deny). Deviations and notes:
  - The T0.1 Cargo `license` field landed in T0.5 as `workspace.package.license`.
  - No `repository` URL in Cargo metadata, because no remote exists yet. Add it before publishing (T13.4).
  - The workspace uses edition 2024 with `rust-version = "1.85"` and `unsafe_code = "forbid"`. If a later task needs `unsafe` (for example process-group kill in T3.2), prefer a safe crate such as `nix` or `rustix` over relaxing the lint.
  - `CLAUDE.md` and `AGENTS.md` share one body by hand for now. T8.2 replaces this with a generated template and a snapshot test.
  - CI runs `--ignored` (Docker isolation) tests on Linux only, which matches the T3.6 / v0.1 gate.
  - No scope drift. Next: Phase 1 (T1.1).
- 2026-11-19 — **Phase 1 aligned.** Gate passed: 57 tests; the fixture runners cover 75 policy-fixture cases and 66 adversarial cases, plus a meta-test. Deviations and additions:
  - **Added modules.** `afg_core::builtin` embeds `policies/*.yaml`. `afg_core::conformance` holds the fixture types and is reused by the v0.2 hook conformance work (T9.3).
  - **Matching semantics.** `deny` and `require-approval` rules match their tail as an *ordered subsequence*, so interleaved flags cannot evade them (`kubectl -n prod delete`). `allow` and `route` rules need an exact prefix and support `denyArgs`/`allowFlags`. The validator rejects constraints on deny and approval rules, because constraints would weaken them. This needs documenting in `docs/policy-reference.md` (T6.3).
  - **Opacity.** Interpreters (python, node, ...) are always opaque, so `allow` never applies to them, and the validator warns about such rules. Routing them to a container is the supported path.
  - **Default policy.** Dependency installs are `require-approval` rather than routed to a container: the container defaults to `network: none`, so installs would always fail there. `strict` and `ci` deny installs.
  - **Risk.** `include_str!` reaches outside the crate (`../../../policies`), which blocks `cargo publish`. Before T13.4, move the policies into the crate or copy them in `build.rs`.
  - **Risk.** The `rg` allow rule blocks `--hidden` and `--no-ignore`, but a committed, unignored secrets file is still searchable. The T2.5 risk detector should flag that case.
  - **Fallback format.** In YAML the fallback is `deny | require-approval | { route: <backend> }`, implemented with an untagged serde representation because serde_norway uses YAML tags for enums.
  - No scope drift. Next: Phase 2 (T2.1).
- 2026-11-19 — **Phase 2 aligned.** Gate passed: 76 tests in total, fmt, clippy and deny. Deviations and follow-ups:
  - **Gap.** Detection and the default policy don't fully agree. Some suggested commands aren't covered by `policies/default.yaml`, so the fallback denies them: `go mod download` and `cargo fetch` (T2), `bun run <script>`, `yarn typecheck`. **T5.1 must fix this.** `afg init` should generate per-project rules from the detection results: an allow rule for each detected T0/T1 command and `require-approval` for T2 installs. It also needs a consistency test: every detected T0/T1 command is allowed by the generated policy, and no T2 command is allowed locally.
  - **Behavior.** Node workspaces report each package separately; they don't cover their children. Cargo and `go.work` workspaces do cover their members.
  - **Limitation.** The risk detector reports secret-like files that are *present*, not ones that are *committed*, because detection never runs `git`. The message says so.
  - **Dependency.** `afg-detect` depends on `afg-core` only to reuse the protected-file globs. It contains no policy logic, so ADR 0002 holds.
  - No scope drift. Next: Phase 3 (T3.1).
- 2026-11-19 — **Phase 3 aligned.** Gate passed: 104 tests, plus 10 Docker isolation tests that passed with `--ignored` against Docker 29.3.1 (linux/arm64, Docker Desktop). No `afg-` containers were left behind. Deviations and notes:
  - **Pinning landed early.** The pinning primitives (`pin.rs`) came with T3.1 because `ExecutionRequest` carries them. T3.5 wired the verification into both backends.
  - **Shared spawning.** Process spawning lives in `process.rs` and is shared by both backends: no shell, cleared environment, closed stdin, process group killed after exit or timeout.
  - **Docker hardening beyond the plan.**
    - `--entrypoint=argv[0]`, so an image's ENTRYPOINT can't wrap the command in a shell.
    - `--init`.
    - `--memory-swap` equal to `--memory`.
    - `HOME=/tmp`.
    - Env values reach the container through the docker CLI's environment (`--env NAME`), so they never show on a command line.
    - Every run ends with `docker rm -f`, which covers timeouts.
  - **Snapshot walking.** Snapshots use the `ignore` crate instead of `git ls-files`, because git can run programs configured by the repository (fsmonitor, hooks). Changes made inside the container are discarded. The README must say so (T6.3).
  - **Test fix.** The network test originally asserted that `/sys/class/net` contains only `lo`. That fails on Docker Desktop's kernel, which lists inert tunnel devices. It now asserts that there are no IPv4 or IPv6 routes and that egress fails, which still catches any real connectivity.
  - **Open item.** The image is a mutable tag (`debian:stable-slim`) and is pulled when missing. Recommend pinning a digest (`image@sha256:…`) in `docs/policy-reference.md` (T6.3), and consider a `pull: never` option in v0.2.
  - **Open item.** The CLI (T5.4) must map policy settings onto executor requests: the env allowlist from `backends.*.env`, the timeout and the limits. It must also pin the program and script arguments when the decision is made, via `pin::pin_request_files`.
  - No scope drift. Next: Phase 4 (T4.1).
- 2026-11-19 — **Phase 4 aligned.** Gate passed: 116 tests, including proptest-based redaction properties, plus 10 ignored Docker tests. Deviations and notes:
  - **MSRV.** Raised to Rust 1.89 for `std::fs::File::lock` (cross-process locking with no extra dependency).
  - **Audit records.** Records store output *digests* (length, SHA-256, truncation), never output bytes. `afg audit` therefore cannot replay output, which is deliberate: it removes a whole class of leaks.
  - **Redaction is applied in `AuditLog::append`**, so callers can't forget it. It also scrubs reasons and errors, since they may quote argv values.
  - **Limitation.** Redaction is pattern-based and best effort. Environment values are never recorded, and this must be stated in `docs/security-boundaries.md` (T6.3).
  - No scope drift. Next: Phase 5 (T5.1). T5.1 must also close the Phase 2 detection/policy gap.
- 2026-11-19 — **Phase 5 aligned.** Gate passed: 132 tests, plus 11 Docker tests that passed with `--ignored`, including the untrusted-script container demo run through the real CLI. Deviations and notes:
  - **Extra commands.** `afg policy schema`, `afg init --template/--dry-run`, and `afg run --quiet`.
  - **Exit codes.** 0 or the child's own code, 2 for config errors, 124 for a timeout, 125 for an exec error, 126 for denied, not approved or an integrity failure, and 127 for not found.
  - **Approval channel.** It is `/dev/tty` only, and only an exact `yes` approves. `AFG_NO_TTY` can only force a refusal.
  - **Security limitation, verified by hand.** A process that controls a pseudo-terminal (for example `script`, or an agent that allocates a PTY) *can* answer the prompt. Tasks for v0.2:
    - Add signed, out-of-band, one-time approval tokens: `afg approve <id>` from a separate terminal, bound to the decision hash. **Added to Phase 7 as T7.4.**
    - Until then, `docs/security-boundaries.md` (T6.3) must state the limitation.
  - **Phase 2 gap closed.** `afg init` generates `detected-validation` and `detected-dependencies` rules, and a consistency test enforces the T0/T1/T2 rule.
  - **Observation.** `git --version` is denied, because the default policy only allows specific git subcommands. That is fail-closed by design; users can add rules.
  - **Audit.** If the audit log can't be opened, `afg run` refuses to execute. If writing the final record fails, it exits 125.
  - No scope drift. Next: Phase 6 (T6.1).
- 2026-11-19 — **Phase 6 aligned, and the v0.1 gate passed.**
  - **Definition of Done results.**
    - fmt and clippy (`-D warnings`) pass.
    - 134 tests pass, with 0 failures.
    - The 11 Docker tests pass with `--ignored`.
    - cargo-deny passes.
    - `scripts/ci-demos.sh` passes: demo 2, the denial with audit evidence, and demo 3, the isolated untrusted script.
    - A secret scan found only the documented fake placeholders.
    - The README quickstart was verified from a **fresh `git clone` and `cargo install --path crates/afg-cli`**.
  - **Bug found by the clean-checkout run, and fixed.** The local backend ran the canonical program path, which broke rustup's multicall `cargo` (`~/.cargo/bin/cargo` is a symlink to `rustup`). The executor now sets `argv[0]` to the name as invoked (`CommandExt::arg0`) while still executing the canonical path. A regression test was added. **Follow-up:** add a CLI-level regression test using a symlinked multicall shim (T7.1 or later).
  - **Not verified locally.** The Docker isolation suite and demos have run only on macOS Docker Desktop (linux/arm64). The Linux reference runner exercises them through `.github/workflows/ci.yml`, which hasn't run yet because there is no remote. Go and Zig toolchains are absent locally; the Go example tests run in CI only once a Go setup step is added (T10.5).
  - **Release.** Version bumped to `0.1.0`, fast-forward merged to `main`, and tagged `v0.1.0` locally. Nothing was pushed.
  - **Scope check against the reference.** v0.1 delivers the reference's "Rust CLI + Policy Engine + Docker Sandbox" success criterion: `afg init → afg doctor → afg run → audit report` on a fresh Go/Rust/Next.js repository, with the dangerous command denied and the restricted container unable to reach host test credentials. MCP was dropped, per the user's decision (ADR 0005).
  - Next: milestone v0.2 (Phase 7, T7.1), on branch `milestone/v0.2`.
- 2026-11-19 — **Phase 7 aligned.** Gate passed: 152 tests, the 11 Docker tests and cargo-deny. The Claude Code hook contract was verified against the current official docs before T7.1:
  - Input is `tool_input.command` on stdin.
  - Output is `hookSpecificOutput.permissionDecision` (`allow` / `deny` / `ask` / `defer`) with `permissionDecisionReason`, on exit 0.
  - Registration uses `hooks.PreToolUse[].matcher` plus `hooks[].{type, command, args, timeout}`. `args` is exec form, with no shell.
  - Permission precedence is deny > ask > allow, path rules use the `~/` and `//` anchors, and Edit rules cover every file-editing tool.

  Deviations and additions:
  - **Tokenizer location.** The shell-string tokenizer and `Engine::evaluate_shell` live in `afg-core`, which keeps decisions in one engine (ADR 0002). Unparseable strings are evaluated as the opaque `sh -c <string>`.
  - **Hook mapping.** `route` becomes `deny` with `afg run` guidance, because native Bash can't route. `allow` becomes **defer** by default, since native Bash doesn't clear the environment the way `afg run` does; `--allow-mode allow` is opt-in.
  - **No allow rules from sync.** `afg agents sync claude` generates no Bash *allow* rules, because Claude's prefix rules can't express `denyArgs`. It generates Read/Edit deny rules for protected paths and Bash deny/ask rules that mirror the policy.
  - **Formatter hook.** The PostToolUse formatter (T7.2) runs its formatter through the policy and the local executor. `[rustfmt]` was added to all built-in T1 rules, and the example policy was regenerated.
  - **T7.4 approval tokens.** This task was added during the Phase 5 alignment. `afg` refusing to run itself is now a built-in forbidden rule, and `~/.config/agentforge` is a built-in protected path. The residual risk (an agent unconfined by afg) is documented.
  - **Open.** The CLI-level multicall regression test from the Phase 6 follow-up is still pending; it moves to T9.3.
  - Next: Phase 8 (T8.1). The Codex config keys must be verified against the official docs first.
- 2026-11-19 — **Phase 8 aligned.** Gate passed: fmt, clippy, all tests and deny. The Codex config keys were verified against the current Codex config reference (now hosted at learn.chatgpt.com):
  - `sandbox_mode` takes `read-only`, `workspace-write` or `danger-full-access`.
  - `approval_policy` takes `on-request` or `never`. `untrusted` is unsupported and `on-failure` is deprecated.
  - The `[sandbox_workspace_write]` table has `network_access`.
  - The `[shell_environment_policy]` table has `inherit = core` and `ignore_default_excludes = false`, which drops KEY/SECRET/TOKEN variables.
  - Project `.codex/config.toml` files are read only for trusted projects.

  Deviations:
  - The Codex config is written only when it is absent. An existing config is never rewritten; the differing keys are reported. This respects user ownership of Codex settings.
  - T8.2 also enforces the Phase 0 note: this repo's own `CLAUDE.md` and `AGENTS.md` must share one body.

  Next: Phase 9 (T9.1).
- 2026-11-19 — **Phase 9 aligned, and the v0.2 gate passed.**
  - **Gate results.** fmt and clippy pass, 160 tests pass with 0 failures, the 11 Docker tests pass, cargo-deny passes, and the CI demos pass.
  - **T9.1.** SARIF results are anchored at the deciding rule's line in `agentforge.yaml`. Built-in rules fall back to line 1. Audit ids serve as partial fingerprints.
  - **T9.2.** The composite action builds `afg` from source, because there are no release binaries until T13.4. It is self-tested in CI with `uses: ./` against the example. Not verified: the action and the CI workflows have never run, since there is no remote.
  - **T9.3.** Conformance covers every policy and adversarial fixture (all cases without `requested`). Hook decisions are identical whenever the quoted string tokenizes, and the multicall `argv[0]` regression test is now in place.
  - **Fix.** `cargo add --path` had pinned the internal path dependencies to `0.1.0-alpha.0`, which blocked the version bump. The pins were removed.
  - **Housekeeping.** A stray, gitignored `examples/polyglot-monorepo/.agentforge/` left by a manual run was removed. `afg audit report` creates the audit directory when it opens the log; it could open it read-only instead (low priority).
  - **Release.** Version `0.2.0`, fast-forward merged to `main`, tagged `v0.2.0` locally, not pushed.
  - Next: milestone v0.3 (T10.1), on branch `milestone/v0.3`.
- 2026-11-19 — **Phase 10 aligned, and the v0.3 gate passed.**
  - **Gate results.** fmt and clippy pass, 167 tests pass with 0 failures, the 11 Docker tests pass, cargo-deny passes, and the demos pass.
  - **Deviation: hybrid detectors (T10.1).** Go, Zig, Python and Mojo are data-driven profiles. Rust and Node remain code detectors, because they parse manifests (Cargo `[workspace]`, `package.json` scripts and package managers), which a static profile can't express without becoming a mini-language. The profile format supports:
    - markers, including `*` globs;
    - trait files;
    - covering of child directories;
    - a minimum-version field;
    - `{marker}` substitution.
  - **The safety net worked (T10.2).** The `init` consistency test caught `zig build --fetch` (T2) matching the `[zig, build]` allow prefix. `--fetch` is now in the validation rule's `denyArgs`.
  - **Python.** `python` itself stays opaque and routes to the container. pytest, ruff and mypy are allowed as T1.
  - **Zig version check.** T10.2 reports `minimum_zig_version` as a `min-version:` trait. Comparing it with the installed toolchain would mean running `zig`, which detection never does.
  - **Not verified locally.** Go and Zig aren't installed here, so the Go and Zig live tests skipped locally. `examples/zig-project` has never been compiled; it targets the Zig 0.14/0.15 build API, and CI pins Zig 0.15.1. The first CI run must confirm it. The Rust live test did run.
  - **Risk carried forward.** More `include_str!` calls reach outside the crate (`language-profiles/`). This must be resolved before `cargo publish` (T13.4).
  - **Release.** Version `0.3.0`, fast-forward merged to `main`, tagged `v0.3.0` locally.
  - Next: milestone v0.4 (Cloudflare). T11.2 needs the current Sandbox SDK docs. A live deployment would need a Cloudflare account, which we don't have, so T11.5's live test stays opt-in.
- 2026-11-19 — **Phase 11 aligned, and the v0.4 gate passed.**
  - **Gate results.**
    - fmt and clippy pass, 178 tests pass with 0 failures, and the 12 ignored-suite tests pass (11 Docker, plus the live Cloudflare test, which skips without credentials).
    - cargo-deny passes, and so do the demos.
    - The pnpm checks pass: the policy types match the schema, the adapter type-checks, and the 5 vitest tests pass.
  - **SDK verification (T11.2).** Before writing the adapter, I read the current Cloudflare docs (the 0.x → 1.0 migration guide and API map) and the real type definitions (`@cloudflare/sandbox` 1.0.3, `@cloudflare/workers-types` 5.20261119.1). The 1.0 model is a user-written Durable Object, where `env.NS.getByName(id)`, `ctx.container.start({image, enableInternet})` (internet off by default), `exec(argv, {cwd, env, user, stdin})`, `output()` and `destroy()` do the work. There are no sessions, and no timeout option on exec.
  - **Deviation: no SDK dependency.** The adapter doesn't depend on `@cloudflare/sandbox`. Its `Files` helper needs `sandbox-shim` inside the image, so the snapshot is streamed as a tar into `tar -x` over exec stdin instead. That needs only coreutils and tar, and avoids guessing at the shim's install path. The "pin the SDK major version" requirement is therefore met by pinning `@cloudflare/workers-types` and `wrangler`.
  - **Security design.**
    - An HMAC-SHA256 signature over the raw body, checked against one shared test vector by both the Rust signer and the TypeScript verifier.
    - A ±300 s `issuedAt` window.
    - One Durable Object per request id, so replays are refused.
    - The container runs as uid 65534 under coreutils `timeout`, is always destroyed, and has a TTL alarm as a backstop.
    - afg verifies that the manifest hash it gets back matches the snapshot it sent.
  - **Deviation: license exception.** CDLA-Permissive-2.0 is allowed only for `webpki-roots` and `webpki-root-certs`, the Mozilla CA data that ureq/rustls need. ureq uses the platform verifier.
  - **Not verified.** There has been no deployment to a real Cloudflare account. That needs an account and an irreversible migration, which is not something to do without the user. `wrangler deploy --dry-run` accepted the config and bundled the Worker. The live test is opt-in (`AFG_CF_LIVE_ENDPOINT`, `AFG_CLOUDFLARE_KEY`).
  - **Release.** Version `0.4.0`, fast-forward merged to `main`, tagged `v0.4.0` locally.
  - Next: milestone v0.5 (T12.1, the benchmark harness), on branch `milestone/v0.5`.
- 2026-11-19 — **Phase 12 (v0.5) aligned.** T12.1 delivered std-timing benchmarks with no new dependencies (docs/benchmarks.md). Applying the plan's gate: afg's overhead is about 0.1–0.2 ms per command, under a quarter of a bare process spawn. T12.2 (Zig helper) and T12.3 (Mojo plugin) are **skipped and recorded in ADR 0007**, with explicit conditions for revisiting. Zig and Mojo remain supported as *target* languages. There is no code release for v0.5 beyond the benchmarks, so it is tagged `v0.5.0`, version `0.5.0`. Next: milestone v1.0 (T13.1).
- 2026-11-20 — **Phase 13 aligned; the v1.0 gate passed technically; tagged `v1.0.0-rc.1`, not `v1.0.0`.**
  - **Gate results.**
    - fmt and clippy pass, 187 tests pass with 0 failures, and the 12 ignored-suite tests pass (11 Docker isolation tests plus the opt-in live Cloudflare test, which skips).
    - cargo-deny passes, and so do the demos and the pnpm checks.
    - `cargo package --workspace` verifies every crate.
    - The real `~/.config/agentforge` was untouched by tests, and no `afg-` containers were left behind.
  - **Why `-rc.1`.** T13.2 asked for *someone else* to review the threat model. I did an internal red-team pass, which found and fixed four gaps with regression tests: hardlinks, unlisted secret stores, policy tampering (now caught by trust pinning), and Edit rules for afg's own config. An independent external review hasn't happened. SECURITY.md makes it a release blocker, and the plan forbids claiming production readiness without it. **`v1.0.0` is blocked only on that review.**
  - **T13.1.** The cargo-fuzz targets run weekly on nightly in CI. Locally there is no nightly toolchain; I chose not to install one on the user's machine. The same invariants run on stable as proptest properties (about 8,000 cases per run).
  - **T13.4 deviations and findings.**
    - The embedded policies and language profiles moved into their crates, which closes the `include_str!` packaging risk carried since Phase 1.
    - The CLI package is renamed `agentforge-guard` (the binary is still `afg`). All the crate names were checked and are free on crates.io; none are reserved or published.
    - The release workflow publishes only on a version tag when `CARGO_REGISTRY_TOKEN` exists, and marks `-` tags as pre-releases. Its Windows and x86_64 builds have never been compiled; there is no remote, and I didn't install extra targets locally.
    - A stale-version trap: `cargo package` can verify against cached sources of an unchanged version number. Always bump the version before packaging.
  - **T13.5.** `agentforge.dev/v1` has the v1alpha1 structure, and v1alpha1 is accepted with a deprecation warning. `afg policy migrate` changes only the version line and keeps the trust pin if the policy was trusted.
  - **T13.6.** The README now has Install and Commands sections that match `afg --help`, there is a docs index, and there is a Homebrew formula template. The tap repository is not created.
  - **Incident during Phase 13.** A test run wrote 15 policy pins into the real `~/.config/agentforge/trusted/` before the tests were isolated. I checked that every one pointed at a test temporary directory, then removed the directory, which hadn't existed before. Tests now use a throwaway HOME for any command that writes pins.
  - **Remaining for v1.0.0:**
    1. An independent security review, with a regression test for each finding.
    2. A first CI run on a real remote, confirming the Linux Docker suite, the Go/Zig live tests, `examples/zig-project`, the action, the security and release workflows, and the Windows build.
    3. An optional live Cloudflare deployment.
- 2026-11-21 — **Distribution aligned (T14.1–T14.4).** Gate passed: 187 Rust tests, fmt, clippy, deny, `cargo package --workspace`; 6 npm packaging tests; 5 install-script tests; shellcheck and actionlint. Deviations and notes:
  - **Go.** No Go module. Go's registry builds only Go source; Go users use `install.sh`.
  - **Release blocker fixed.** `release.yml` used the retired `macos-13` runner, so no release could complete. It now uses `macos-15-intel`. No `v*` tag had been pushed yet, so no release run was affected.
  - **Repository URL.** Metadata pointed to `github.com/agentforge-guard/agentforge-guard`, which isn't this repository. Now `github.com/dennislee928/AgentForge-Guard`; the Homebrew tap becomes `dennislee928/homebrew-tap`.
  - **Not covered.** No prebuilt musl (Alpine) or Windows arm64 binaries; the npm launcher and `install.sh` say so and point to `cargo install`.
  - **Publishing needs the owner.** crates.io and npm publish only when `CARGO_REGISTRY_TOKEN` and `NPM_TOKEN` are set; both registries can later switch to trusted publishing (OIDC) after the first manual-token release.
- 2026-11-21 — **T14.5.** Socket.dev rated the rc.1 platform packages Quality 37 (no README, sparse metadata) and Supply Chain 51/69. README and metadata fix the quality signals. The remaining supply-chain alerts are inherent: platform packages exist to ship a native binary, and the launcher must spawn it (`spawnSync`, no shell). They are mitigated by npm provenance, `SHA256SUMS` and Sigstore, not removed.
- 2026-11-22 — **Milestone v1.1 planned (Security Validation & Adoption).** Added the priorities P0–P2 and the Security Validation Matrix. All 8 scenarios already have a reproducible test; T15.1 makes them a named, enforced CI table, and T15.2 lists the gaps the current tests do not cover. External review (T15.3) gates v1.0.0.
- 2026-11-22 — **T14.6.** On rc.2, Socket raised platform-package Quality from 37 to 51 and showed no alerts; Supply Chain stayed at 51. The only difference left between the launcher (Quality 99) and the platform packages is the native binary, so rc.3 cuts its size by about 41%. Any score that remains is inherent to shipping a native executable.
- 2026-11-22 — **T14.7.** The Socket API (`/v0/npm/<pkg>/<v>/issues`) on rc.3 reported a critical `licenseSpdxDisj` (the two license files read as "Apache-2.0 AND MIT"), `mixedLicense`, and `emptyPackage` on the platform packages. The owner chose MIT for npm. Still open: `noTests` and `noV1` (low; `noV1` clears at 1.0.0), `unpublished` (Socket lagging behind npm), and `downloadCount: 0`, the largest supply-chain gap, which only adoption fills.
- 2026-11-22 — **Distribution follow-up aligned (T14.8).** The six rc.4 shallow reports and the launcher deep report are recorded in `docs/npm-socket-rc.4.json`, with interpretation in `docs/npm-package-security.md`.
  - **Classification.** All five completed platform scans report only `trivialPackage` at the three-line JavaScript path export. Copying that export does not replace the Rust executable. Keep the minimal wrapper; no padding, scanner exclusions or policy ignores were added. The API does not expose enough metric inputs to attribute every score penalty; earlier claims that all remaining penalties were inherent were too broad.
  - **Packaging fix.** A failing tarball test demonstrated that `files: ["bin", ...]` includes an unexpected fake credential fixture inside `bin/`. The generated manifests now allow only the intended executable. The README now accurately describes the JavaScript export and includes exact tagged signature identity and binary-comparison instructions. The packaging implementation and tests were committed concurrently in `4cd540e`; that commit was preserved, and the task completion and report followed in `4c8e068`.
  - **Gate results.** Workspace build, fmt, clippy with `-D warnings`, 187 Rust tests, cargo-deny and all 10 npm tests passed. The packaging suite packs and extracts all six packages offline and runs the extracted launcher against its host package. The real rc.4 macOS arm64 npm binary matched the release archive byte for byte, and GitHub attestation verification passed for that archive.
  - **Validation environment.** Docker is unavailable, so the 11 Docker tests were not run; the live Cloudflare test also remains opt-in. The Rust mock-server tests needed loopback access outside the sandbox. An existing contributor-doc parity failure was fixed by using the same agent-neutral sentence in both files; no tests or policy rules were weakened. Cosign is not installed locally, so the documented cosign command was not executed.
  - **Release scope.** No version bump, publication or Socket organization-policy change. The fixes apply to the next release; rc.4 and its public scores remain unchanged. The complete post-release OS matrix remains T15.4, and the independent review remains T15.3.
- 2026-11-22 — **Distribution release aligned (T14.9–T14.10), `v1.0.0-rc.5` published.**
  - **Release gate.** Tag `v1.0.0-rc.5` points at `b9fcb84cd821110b32f3ac97518fdb5641af9640`. CI run `44987807855` and Security run `44987808069` passed before tagging, including Linux Docker isolation, macOS/Linux tests, demos, Action smoke test, npm packaging, dependency scans and CodeQL. Release run `44988317340` passed all five native builds, signing, npm and crates.io publication.
  - **Publication verified.** GitHub exposes five platform archives, the SBOM, installer, checksums and Sigstore bundles. All checksum entries passed. GitHub build attestations verified for all five archives and the SBOM against the rc.5 tag. A temporary install of all six npm packages passed `npm audit signatures`: six verified registry signatures and six verified attestations. Each platform binary matched its GitHub archive byte for byte; the host launcher returned `afg 1.0.0-rc.5`. All five Rust crates were confirmed published and not yanked through the crates.io API. npm's `next` and `latest` tags point to rc.5, following the existing prerelease-only dist-tag policy.
  - **Scope and remaining gates.** Published as a prerelease; no stable 1.0.0 claim and no Socket policy changes. Foreign-platform binaries were inspected and compared, not executed locally. T15.4 still covers the full OS installation matrix, and T15.3 still requires an independent security review. The earlier rc.4 Socket evidence remains a historical snapshot; public scanner scores may refresh independently.
- 2026-11-22 — **Distribution quality follow-up aligned (T14.11).** Socket CLI refreshed all six rc.5 packages; the detailed score/issue endpoints identified the actionable README and missing-test inputs. `docs/npm-socket-rc.5.json` records the selected metrics. All five platform score/quality component objects were identical in this snapshot: quality 0.691979, supply chain 0.574007, README length 54, code length 3 and downloads 0.
  - **Implemented.** All six npm artifacts ship runnable tests. A shared integrity verifier checks platform package identity and binary hashes before launch and from the path export, while preserving the exported string API. The generated artifact manifest also records the source archive digest. Platform READMEs cover requirements, tests, actual verification, limitations and troubleshooting (53 to 157 physical newline-terminated lines in the real-archive preview). No padding, artificial downloads, install/publish hooks, new dependencies or scanner exclusions were added.
  - **Gate results.** Workspace build, fmt, clippy, 187 Rust tests, cargo-deny and 18 npm packaging tests passed. The npm suite includes seven pre-execution corruption/metadata/symlink regressions and runs all six extracted packages' self-tests. A separate preview using the real attested rc.5 archives passed all six package test suites, and the host launcher returned `afg 1.0.0-rc.5`. No existing deny, adversarial or isolation test was weakened. Docker isolation and live Cloudflare suites were not run locally for this packaging-only follow-up.
  - **Limits.** The zero-download component requires real adoption; the `noV1` warning does not justify bypassing the independent-review gate. The detailed endpoint's MIT policy alert conflicts with its license score and shallow CLI view; no license/policy workaround was applied. The verifier detects damaged installations and binary-only changes, not an attacker who can replace the manifest/verifier or race the post-check execution. It is not policy authorization; `afg-core` remains the sole policy authority.
  - **Publication.** Source changes only, on `fix/npm-package-quality`. The rc.5 version was not republished; public score changes and alert removal require a new version and a fresh Socket scan. Filesystem/cryptographic findings may legitimately accompany the verifier. The complete platform installation/release verification matrix remains T15.4.
