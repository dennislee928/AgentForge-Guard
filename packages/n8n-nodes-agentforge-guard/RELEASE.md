AgentForge Guard n8n integration 0.1.1 adds Policy Evaluate, Command Analyze and
Security Validate using an authenticated HTTP gateway backed by `afg-core`.
The package contains no native executables or runtime dependencies.

Build the gateway from this tag; the existing Rust/npm CLI `1.0.0-rc.6` predates
the gateway. See the package README for setup and the API security boundary.

The node preserves allow, deny, approval and routing decisions. Security Validate
stops on all non-allow outcomes. Network and response-schema errors stop by
default; n8n Continue-on-error produces an explicit error without a decision.
No submitted command is executed by the gateway or the node.

Checks include Rust formatting, clippy, workspace tests and cargo-deny; official
n8n build/lint; node unit and real HTTP/Rust integration tests; and an exact
tarball-content/load check. The GitHub workflow publishes with npm provenance.

Directory listings and official n8n verification are separate external outcomes.
This release does not claim NCNodes/WorkflowNodes listing, n8n verification or
stable Rust 1.0.0 security readiness.

Known advisories remain in the official n8n development SDK dependency tree.
The owner accepted that release-specific development risk; scan reports and
rollback instructions are retained. The published node has no runtime
dependencies. The full Security workflow is not claimed green. See
`docs/n8n-release-risk.md` in this tag and the attached development advisory report.

The previous 0.1.0 tag was not published to npm: its release workflow invoked
Rust formatting from the npm subdirectory without a manifest path. Version 0.1.1
fixes that invocation and retains the failed tag and CI logs.
