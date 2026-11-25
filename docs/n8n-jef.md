# JEF decision-support integration

`workflows/jef-incident-review.json` combines the AgentForge Guard community node
with the separately installed `n8n-nodes-jef@0.2.0-rc.4`. It does not add a second
service or a JEF dependency to the Guard npm package.

The contract was checked against JEF's published SDK metadata and source:

- [JEF node operations](https://github.com/cyber-security-dev-dep-mitake-com-tw/jef/blob/main/connectors/n8n/nodes/Jef/Jef.node.ts)
- [JEF client transport](https://github.com/cyber-security-dev-dep-mitake-com-tw/jef/blob/main/packages/jef-sdk-ts/src/client.ts)
- [JEF capabilities](https://github.com/cyber-security-dev-dep-mitake-com-tw/jef/blob/main/docs/CAPABILITIES.md)

JEF is a System One decision engine with SOAR decision-support integrations. It
does not itself isolate hosts, disable accounts or close alerts. Do not describe
this template as automated incident response or as JEF granting Guard approval.

## Flow

1. Guard evaluates structured argv using the operator's policy.
2. `allow` reaches a no-op; execution still requires `afg run` on its actual host.
3. Every other effect sends only `source`, `effect`, `ruleId` and `policyHash` to
   JEF Ask Many, which uses `POST /v1/systemone` with `{state, questions}`.
4. JEF recommends a human review team from fixed choices. The workflow then
   stops with an error, regardless of the model's recommendation or confidence.
5. JEF errors also stop the flow. No approval, authorize-action or execution node
   is included. Keep On Error set to Stop Workflow.

Only decision metadata is forwarded. Raw argv, reasons, file content and API keys
are not included in the JEF state. Rule identifiers can still reveal deployment
context; review that metadata before connecting an external service.

## Setup

Install both community packages in your self-hosted n8n instance. Create separate
Guard and JEF API credentials, configure your own reachable JEF deployment, import
the template, and choose the credentials on their respective nodes. Use HTTPS
and an authenticating proxy remotely. No credentials are embedded in the template.

Run the default denied `terraform destroy` example and inspect the Guard result,
the JEF recommendation and the final stopped execution. Repeat with an approval
request and a shell requiring isolation. All must remain blocked. Change argv to
`["git","status"]`; the allow no-op must run without sending an incident to JEF.

## Test boundary

The full-runtime CI test installs the real published JEF community node and runs
the n8n expression, branch and HTTP transport against a contract fixture. It
checks all three non-allow effects, minimum-data forwarding, the final stop, and
that allow sends no incident. This is a workflow/contract test, not a live JEF
inference, calibration or automatic-remediation test. The fixture is explicitly
fake and is not included in the npm artifact. Validate model quality/calibration
on your own JEF deployment before relying on its decision-support advice.
