# Workflow templates

Import these JSON files into a self-hosted n8n instance with the community node
installed, then select your AgentForge Guard API credential on every Guard node.
No credential IDs or keys are embedded. Run manually against your reviewed
gateway policy. The bundled default policy produces these examples:

| Template | Expected result |
| --- | --- |
| `policy-gate.json` | `git status` returns allow and reaches the no-op branch |
| `security-validate.json` | `terraform destroy` stops at Security Validate |
| `command-analyze.json` | `sh -c` returns route to container without execution |

In the gate template, replace Argv with `["terraform","destroy"]` to test deny,
`["kubectl","apply"]` to test approval, or `["sh","-c","echo example"]` to test
routing. All three reach Stop And Error. Set an invalid API key or stop the gateway
to verify that no success output reaches the branch. Do not enable Continue on
Error for security gates; if enabled, explicitly reject items with an `error` field.

The allow branch is a no-op. Re-evaluate using `afg run` on the execution host
before any real execution. The gateway's filesystem and PATH can differ from the
execution host, and evaluation does not bind later execution to the checked files.

`jef-incident-review.json` additionally uses `n8n-nodes-jef@0.2.0-rc.4`. Select a
separate JEF API credential. Non-allow decisions send only four metadata fields
for a review-team recommendation and then stop. JEF cannot override Guard. See
`docs/n8n-jef.md` for the contract, setup and the mock-server test boundary.

None of these templates approves an operation or executes the evaluated command.
