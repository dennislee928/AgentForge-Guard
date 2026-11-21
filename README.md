# AgentForge Guard

**AgentForge Guard (`afg`) is a policy-driven, agent-agnostic code-execution tool for AI coding agents.** A single policy file decides what an agent's commands may do:

- Deterministic development work (builds, tests, linters) runs **locally**, with your native toolchain and caches.
- Untrusted code (scripts, generated shell) runs in a **Docker sandbox** with no network and no host secrets.
- Infrastructure changes (deploys, `kubectl apply`, `git push`) need **human approval**, or are denied.
- Every decision is written to a **redacted audit log**.

> Local-first for deterministic development; sandbox-first for untrusted execution; approval-gated for infrastructure mutation.

Status: **v1.0.0-rc.1, a release candidate.** It is not yet production-ready: an independent security review is still pending (see [SECURITY.md](SECURITY.md)). See [docs/plan.md](docs/plan.md) for the roadmap.

## Install

Each method installs the `afg` command. While only release candidates exist, ask for the version explicitly: `agentforge-guard@next` on npm, `--version 1.0.0-rc.1` for cargo, and the versioned script URL below. After the first stable release, the script is also at `releases/latest/download/install.sh`.

| You have | Command |
|---|---|
| Node.js 18+ | `npm install -g agentforge-guard@next`, or run once with `npx agentforge-guard@next doctor` |
| Rust | `cargo install agentforge-guard --version 1.0.0-rc.1` |
| Neither (Go, Python, ...) on macOS or Linux | `curl -fsSL https://github.com/dennislee928/AgentForge-Guard/releases/download/v1.0.0-rc.1/install.sh \| AFG_VERSION=1.0.0-rc.1 sh` |
| Windows without Node or Rust | the `.zip` from [GitHub Releases](https://github.com/dennislee928/AgentForge-Guard/releases) |

Prebuilt binaries cover macOS (arm64, x64), Linux glibc (x64, arm64) and Windows x64. The npm package runs the binary from a per-platform optional dependency; it downloads nothing at install time and runs no install scripts. `install.sh` checks the archive against `SHA256SUMS` and, if `cosign` is installed, its Sigstore signature (`AFG_REQUIRE_COSIGN=1` makes that mandatory). Every release file is signed with Sigstore and has SLSA build provenance; npm packages carry npm provenance. A Homebrew formula template is in [packaging/homebrew](packaging/homebrew).

## Commands

| Command | Purpose |
|---|---|
| `afg init` | Write `agentforge.yaml` from detected stacks, and pin it as trusted |
| `afg doctor` | Detected projects, per-command decisions, backend health, trust status, risks |
| `afg run -- <argv>` | Run a command under the policy (managed mode, the only mode that enforces) |
| `afg policy explain -- <argv>` | Show a decision without running anything |
| `afg policy validate` / `schema` | Check the policy / print its JSON Schema |
| `afg policy trust` | Pin the reviewed policy; later edits deny every command until it is re-trusted |
| `afg policy migrate --write` | Upgrade `agentforge.dev/v1alpha1` to `v1` |
| `afg approve [<id>]` | A human approves a pending `require-approval` request |
| `afg audit tail` / `show` / `report --format sarif` | Read the audit log, or export it for code scanning |
| `afg agents sync claude\|codex` | Generate agent settings, hooks and instructions from the policy |
| `afg hook claude-pretool` / `claude-posttool-format` | Claude Code hooks (registered by `agents sync`) |

## Quickstart

Requires Rust 1.89+. Docker is optional and only needed for the container backend.

```sh
git clone <this repository> agentforge-guard && cd agentforge-guard
cargo install --path crates/afg-cli          # from source; installs the `afg` binary

cd examples/polyglot-monorepo                # or any repository of yours
afg init --force                             # writes agentforge.yaml from detected stacks
afg doctor                                   # stacks, per-command decisions, backends, risks
afg policy trust                             # (init already did this) pin the reviewed policy; later edits deny everything
```

Run commands through the policy:

```sh
(cd services/rust-service && afg run -- cargo test)   # allowed → runs locally
afg run -- terraform destroy                 # denied → exit 126, audited
afg run -- sh scripts/untrusted.sh           # routed → Docker, no network, no secrets
afg run -- kubectl apply -f k8s/             # asks a human on the terminal
afg policy explain -- git -c core.pager=sh log   # shows why, without running anything
afg audit tail
```

## Demos

Detected stacks: Go, Rust, Node.js, TypeScript and Next.js (all code detectors), plus Zig, Python and Mojo (data-driven profiles in [`crates/afg-detect/language-profiles/`](crates/afg-detect/language-profiles/)).

1. **Polyglot repository.** In `examples/polyglot-monorepo`, `afg doctor` finds the Go API, the Rust service and the Next.js app, and shows the policy decision for each verification command.
2. **Unsafe command prevention.** `afg run -- terraform destroy` is denied by the `destructive-operations` rule, and the audit log records argv, cwd, the policy hash and the rule.
3. **Untrusted script execution.** `scripts/untrusted.sh` runs in a container. It cannot read `.env`, `~/.ssh` or the Docker socket, and cannot reach the network.

Demos 2 and 3 run in CI on every pull request ([scripts/ci-demos.sh](scripts/ci-demos.sh)).

## How it works

```text
argv ─► normalize ─► protected paths ─► rules ─► fallback ─► backend ─► audit
         │             │                 │         │
         │             │                 │         └ default: deny
         │             │                 └ deny > require-approval > route > allow
         │             └ ~/.ssh, ~/.aws, .env*, *.pem, docker.sock … → deny
         └ resolve the executable, unwrap env/nice/timeout, mark shells,
           interpreters, xargs/make and shell syntax as *opaque*
```

- **Fail closed.** Unknown commands are denied unless the policy's `fallback` says otherwise. Opaque commands, such as `bash -c …` or `env X=1 cmd`, never match `allow` rules. They can only be routed to a sandbox, sent for approval, or denied.
- **No implicit shell.** `afg` runs a structured argv against the executable's resolved absolute path, with a cleared environment (an allowlist) and closed stdin.
- **TOCTOU checks.** The program and any script arguments are pinned (hashed) when the decision is made and re-checked just before execution.
- **The container backend** runs `docker run` with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, a non-root user, memory, CPU and pids limits, and a *copy* of the workspace that excludes gitignored and credential files. The Docker socket and `$HOME` are never mounted. **Changes made inside the container are discarded.**

All documentation is indexed in [docs/README.md](docs/README.md).

## Agent integration (Claude Code, Codex)

```sh
afg agents sync claude     # .claude/settings.json: hooks + Read/Edit/Bash deny & ask rules; CLAUDE.md section
afg agents sync codex      # AGENTS.md section; .codex/config.toml (only if absent)
```

- **Claude Code PreToolUse hook** (`afg hook claude-pretool`): every Bash command string is evaluated by the same engine. `deny` becomes deny, `require-approval` becomes ask, and `route` becomes deny with a hint to use `afg run --`. An allowed command defers to Claude Code's own permissions. Strings afg can't analyze (`$(…)`, redirections, globs) are treated as opaque `sh -c`.
- **PostToolUse formatter** (`afg hook claude-posttool-format`): after Claude finishes an Edit or Write tool operation, rustfmt, gofmt or prettier runs, but only if the policy allows the formatter.
- **Out-of-band approval**: without a terminal, `afg run` prints a pending id. A human runs `afg approve <id>` in their own terminal to mint a single-use token that is bound to that exact command. `afg` refuses to run itself, so a confined agent can't approve its own request.
- **Reports**: `afg audit report --format sarif` produces SARIF for GitHub Code Scanning, and `action.yml` is a composite GitHub Action that validates the policy and uploads the report.

## Managed mode vs. integration mode

| | Managed mode: `afg run -- …` | Integration mode: agent hooks |
|---|---|---|
| Who spawns the process | afg | the agent |
| Policy enforcement | **enforced** by afg's executor | advisory; it depends on the agent's hook API |
| Sandbox, env clearing, pinning | yes | only what the agent provides |

These are **not** equivalent levels of protection. See [docs/security-boundaries.md](docs/security-boundaries.md).

## Limitations

Read these before relying on afg:

- **Prompt instructions are not a security boundary**, and neither is argv matching. Allowing `go test` or `cargo test` lets arbitrary test code run with your privileges.
- **Approval is read from the controlling terminal**, or comes from a single-use `afg approve <id>` token. A process that drives its own pseudo-terminal, or that runs outside afg, can approve as the user. Use `deny` for operations an agent must never trigger.
- **Redaction is pattern-based and best effort.** Environment *values* are never recorded, and output is stored only as a length and a SHA-256.
- **Docker isolation is only as strong as the Docker runtime and kernel.** Pin images by digest.
- **Agents that don't use `afg` are not affected by it.** Agent-level read rules and OS sandboxes are still needed.
- **The hook sees only what the agent sends it.** Tools other than Bash, such as file reads, are covered only by the generated Read/Edit deny rules.
- **The Cloudflare backend** (`packages/cloudflare-adapter`) is contract-tested against a mock Worker but has not run against a live account yet. See [docs/provider-compatibility.md](docs/provider-compatibility.md).
- **There is no Windows support for process-group cleanup yet.**

## Exit codes

| Code | Meaning |
|---|---|
| command's own code | `afg run` executed the command |
| 2 | usage or configuration error (for example, no `agentforge.yaml`) |
| 124 | the command timed out |
| 125 | afg could not execute an approved command (for example, Docker is unavailable) |
| 126 | denied by policy, approval refused, or a pinned file changed |
| 127 | executable not found |

## Development

```sh
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cargo test --workspace -- --ignored          # Docker isolation suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this work, as defined in the Apache-2.0 license, shall be dual
licensed as above, without any additional terms or conditions.
