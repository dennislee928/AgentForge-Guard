// AgentForge Guard Cloudflare backend: a Worker plus one Durable Object
// (with a container) per approved request. See ../README.md.

import { DurableObject } from "cloudflare:workers";
import {
  type ExecuteRequest,
  type ExecuteResponse,
  type Limits,
  WORKSPACE,
  base64ToBytes,
  stream,
  validate,
  verifySignature,
} from "./protocol";

export interface Env {
  AFG_SANDBOX: DurableObjectNamespace<AfgSandbox>;
  /** Hex secret shared with `afg` (wrangler secret put AFG_SIGNING_KEY). */
  AFG_SIGNING_KEY: string;
  /** Container image reference passed to container.start(). */
  AFG_IMAGE: string;
  MAX_ARCHIVE_BYTES?: string;
  MAX_TIMEOUT_SECONDS?: string;
  MAX_OUTPUT_BYTES?: string;
  /** Hard lifetime of a sandbox, enforced by an alarm (T11.4). */
  SESSION_TTL_SECONDS?: string;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function limits(env: Env): Limits {
  return {
    maxArchiveBytes: num(env.MAX_ARCHIVE_BYTES, 64 * 1024 * 1024),
    maxTimeoutSeconds: num(env.MAX_TIMEOUT_SECONDS, 600),
    maxOutputBytes: num(env.MAX_OUTPUT_BYTES, 64 * 1024),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || (url.pathname !== "/v1/execute" && url.pathname !== "/v1/cleanup")) {
      return json(404, { error: "not found" });
    }
    const lim = limits(env);
    const body = await request.text();
    if (body.length > lim.maxArchiveBytes * 1.4 + 1_000_000) return json(413, { error: "request too large" });
    if (!(await verifySignature(env.AFG_SIGNING_KEY, body, request.headers.get("x-afg-signature")))) {
      return json(401, { error: "bad signature" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    const problems = validate(parsed, lim, Math.floor(Date.now() / 1000));
    if (problems.length > 0) return json(400, { error: "invalid request", problems });
    const req = parsed as { kind: string; id: string };
    const stub = env.AFG_SANDBOX.getByName(req.id.toLowerCase());
    try {
      if (req.kind === "cleanup") {
        await stub.cleanup();
        return json(200, { id: req.id, cleaned: true });
      }
      return json(200, await stub.run(parsed as ExecuteRequest));
    } catch (e) {
      // Details stay in the Worker log; clients get a generic message.
      console.error("sandbox request failed", e);
      return json(500, { error: "internal error" });
    }
  },
} satisfies ExportedHandler<Env>;

/** One container per approved request. */
export class AfgSandbox extends DurableObject<Env> {
  async run(req: ExecuteRequest): Promise<ExecuteResponse> {
    const container = this.ctx.container;
    if (!container) throw new Error("this Durable Object has no container");
    // Replay protection: an id runs at most once.
    if (await this.ctx.storage.get("used")) throw new Error("request id already used");
    await this.ctx.storage.put("used", true);
    const ttl = num(this.env.SESSION_TTL_SECONDS, 900);
    // Guaranteed cleanup even if this invocation dies (T11.4).
    await this.ctx.storage.setAlarm(Date.now() + ttl * 1000);
    const lim = limits(this.env);
    const start = Date.now();
    try {
      if (!container.running) {
        container.start({ image: this.env.AFG_IMAGE, enableInternet: req.network === "bridge", env: {} });
      }
      await this.waitReady(container);
      await this.check(container.exec(["mkdir", "-p", WORKSPACE]), "mkdir");
      await this.extract(container, base64ToBytes(req.archive));
      await this.check(container.exec(["chown", "-R", "65534:65534", WORKSPACE]), "chown");
      const cwd = req.cwd ? `${WORKSPACE}/${req.cwd}` : WORKSPACE;
      // No timeout option on exec(); wrap in coreutils timeout (124/137 = timed out).
      const proc = await container.exec(
        ["timeout", "--kill-after=5", String(req.timeoutSeconds), ...req.argv],
        { cwd, env: { HOME: "/tmp", ...req.env }, user: "65534" },
      );
      const out = await proc.output();
      return {
        id: req.id,
        exitCode: out.exitCode,
        timedOut: out.exitCode === 124,
        durationMs: Date.now() - start,
        stdout: await stream(out.stdout, lim.maxOutputBytes),
        stderr: await stream(out.stderr, lim.maxOutputBytes),
        manifestHash: req.manifestHash,
      };
    } finally {
      await container.destroy().catch(() => {});
    }
  }

  async cleanup(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
  }

  async alarm(): Promise<void> {
    await this.cleanup();
  }

  private async waitReady(container: Container): Promise<void> {
    for (let i = 0; i < 30; i++) {
      try {
        const p = await container.exec(["true"]);
        if ((await p.exitCode) === 0) return;
      } catch {
        // Not ready yet.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("container did not become ready");
  }

  private async check(p: Promise<ExecProcess>, what: string): Promise<void> {
    const proc = await p;
    const code = await proc.exitCode;
    if (code !== 0) throw new Error(`${what} failed with exit code ${code}`);
  }

  /** Stream the snapshot archive into `tar -x` (no shell, no extra helper binary). */
  private async extract(container: Container, archive: Uint8Array): Promise<void> {
    const proc = await container.exec(
      ["tar", "-x", "--no-same-owner", "--no-overwrite-dir", "-C", WORKSPACE, "-f", "-"],
      { stdin: "pipe" },
    );
    const w = proc.stdin?.getWriter();
    if (!w) throw new Error("no stdin for tar");
    await w.write(archive);
    await w.close();
    const code = await proc.exitCode;
    if (code !== 0) throw new Error(`snapshot extraction failed with exit code ${code}`);
  }
}
