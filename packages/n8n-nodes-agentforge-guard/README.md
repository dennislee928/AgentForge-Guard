# n8n-nodes-agentforge-guard

An n8n Community Node for [AgentForge Guard](https://github.com/dennislee928/AgentForge-Guard),
an open-source Rust policy engine for AI agent commands.

This integration calls an authenticated, self-hosted HTTP gateway. It has no
runtime dependencies, native binaries, filesystem access or command execution.
The host n8n installation supplies the `n8n-workflow` peer dependency.

## Operations

| Resource | Operation | Result |
| --- | --- | --- |
| Policy | Evaluate | Return the Rust engine's decision, backend, rule, reasons and policy hash |
| Command | Analyze | Explain the same deterministic decision without executing the command |
| Security | Validate | Stop with an error unless the engine returns `allow` |

The engine returns `allow`, `deny`, `require-approval` or `route`. Evaluate and
Analyze preserve all four outcomes. They do not grant approval or perform routing.
No remote approval, audit query/export, or MCP inspection API is provided.

## Requirements and installation

Use a self-hosted n8n instance. The development baseline is n8n 2.49.6,
`n8n-workflow` 2.49.4, and Node.js 24; compatibility with other versions requires
testing. The wildcard peer range follows the official n8n tooling's requirements.

After npm publication, install `n8n-nodes-agentforge-guard` through
**Settings → Community nodes → Install**. Follow the
[n8n community installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).
For local development, run `npm ci --ignore-scripts`, `npm run build`,
`npm run lint` and `npm test`. The package uses the official `@n8n/node-cli` build
and lint tools. `npm run dev` starts the official development environment.

## Gateway setup

Build the gateway from the repository containing this integration:

```console
cargo build --locked -p agentforge-guard
target/debug/afg policy explain --json -- git status
```

Review `agentforge.yaml` and the returned `policyHash`. A human can pin the policy
with `target/debug/afg policy trust`. Configure `AFG_GATEWAY_API_KEY` through your
service manager or secret manager: 32–256 ASCII letters, digits, `-` or `_`.
Then start the gateway in the reviewed project directory:

```console
target/debug/afg gateway --listen 127.0.0.1:8787 --policy-hash sha256:REPLACE_WITH_REVIEWED_HASH
```

The published CLI `1.0.0-rc.6` predates the gateway; build this source revision
until a release containing the gateway is published. The integration's `0.1.0`
version is independent of the CLI version.

Use an unprivileged service account, minimal PATH and a read-only workspace.
For a separate n8n host, place the gateway behind a TLS reverse proxy with request
deadlines, connection limits and rate limiting. Bind to an interface reachable by
that proxy using `--listen`. Do not mount the Docker socket or your home directory.
The gateway does not need Docker to evaluate commands.

## Credentials

Create an **AgentForge Guard API** credential:

- **Base URL:** the gateway URL, without `/v1/evaluate`. Use HTTPS remotely;
  `http://127.0.0.1:8787` is suitable when n8n and the gateway share a host network.
- **API Key:** the same value as the gateway service's `AFG_GATEWAY_API_KEY`.

The key is sent as a bearer token. The credential test uses `/v1/health` and the
node uses `/v1/evaluate`. The node refuses redirects. When n8n runs in Docker,
its loopback refers to its own container; use a reachable HTTPS gateway address.

## Usage

Choose a resource and operation, then enter **Argv** as structured JSON:

```json
["git", "status"]
```

Expressions can supply an array or its JSON representation. Shell command
strings are not accepted. Optionally request a container backend; the Rust engine
decides availability and never weakens policy requirements.

Import the examples under `workflows/` from this repository, select your own
credential, and execute manually. Example workflows contain no keys or credential
IDs. Policy and security validation examples demonstrate both allow and deny
behavior without running the evaluated command.

## Failure behavior and security limits

Timeouts (10 seconds), authentication errors, malformed responses, unsupported
schemas, missing policies and policy hash changes stop the node by default.
Security Validate also stops on `deny`, `require-approval` and `route`.
If you enable n8n's **On Error → Continue**, the node outputs only an `error`
field; it never converts an error into an allow decision. Do not wire that output
to an execution step. With Evaluate or Analyze, explicitly branch on
`effect === "allow"` and stop or separately handle every other result.

Evaluation uses the gateway's policy, filesystem and PATH. It is not an execution
permit for another machine. Files and executable identities may change after
evaluation. Use `afg run` on the actual execution host to re-evaluate and enforce
approval, isolation and TOCTOU checks. Argv matching and workflow instructions
are not security boundaries. See the [API contract](https://github.com/dennislee928/AgentForge-Guard/blob/n8n-v0.1.0/docs/n8n-api.md).

## Publication and verification

Publication, directory indexing and n8n verification are separate milestones.
Only claim a directory listing after observing the actual package page. Official
n8n verification requires publication through GitHub Actions with provenance
and acceptance through the [Creator Portal](https://creators.n8n.io/nodes).
Building, linting or installing a community node does not establish verification.
Current evidence is maintained in the repository's `docs/n8n-status.md`.
The owner accepted known advisories in the official development tools for this
release, with retained scan reports and a manual deprecation rollback. The full
Security scan is not claimed green. See [risk acceptance and rollback](https://github.com/dennislee928/AgentForge-Guard/blob/n8n-v0.1.0/docs/n8n-release-risk.md).

## License

MIT. The Rust workspace retains its existing MIT OR Apache-2.0 license.
