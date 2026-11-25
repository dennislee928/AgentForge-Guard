# Official n8n verification submission packet

Package: `n8n-nodes-agentforge-guard@0.1.0`.
Repository: `https://github.com/dennislee928/AgentForge-Guard`.
Release tag: `n8n-v0.1.0` (confirm publication before submitting).
Submission destination: [n8n Creator Portal](https://creators.n8n.io/nodes).

## Description for review

AgentForge Guard integrates its open-source Rust policy engine with n8n using an
authenticated HTTP gateway. Policy Evaluate and Command Analyze return engine
decisions with matched rules, reasons and policy hash. Security Validate stops on
any effect other than allow. The node and gateway do not execute commands or
create approvals. Argv matching and workflow instructions are not security
boundaries; enforcement requires re-evaluation through afg on the execution host.

## Evidence to attach

- Version-specific public npm page and provenance from `publish-n8n.yml`.
- GitHub release tarball and SHA256SUMS; exact package metadata under
  `packages/n8n-nodes-agentforge-guard/package.json`.
- Official `@n8n/node-cli` build/lint and actual self-hosted n8n CI logs.
- `README.md`, `docs/n8n-api.md`, `docs/n8n-release-risk.md`, and example workflows.
- MIT-licensed integration; no runtime dependencies, native executables,
  filesystem/environment access, or arbitrary command execution in the node.
- TLS API deployment and bearer credential instructions, explicit error behavior,
  and real workflow tests for deny, approval, isolation, invalid auth and policy changes.

## Known limitations to disclose

The full development dependency scan reports upstream official-tooling
advisories, accepted by the owner for this release with logs and rollback. This
is not a claim that n8n's runtime is vulnerability-free. The node's production
audit and functional checks are separate. Explain the self-hosted gateway
requirement and that no public hosted service account is supplied.

JEF is an optional, separately installed workflow integration and is not another
service packaged into the Guard node. Its contract test uses the real published
JEF node with a fake downstream server, not live inference or calibration.

## Submission status

Prepared; not submitted by this agent. Creator Portal requires the owner's
authenticated account, which is not available through the connected tools.
After publication, the owner should submit the package and record the submission
ID, date and outcome in `docs/n8n-status.md`. Do not display Verified until official
acceptance or a matching official vetted-node record is observed. The official
[submission guide](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes)
says review can take up to four weeks. Submission itself is not verification.
