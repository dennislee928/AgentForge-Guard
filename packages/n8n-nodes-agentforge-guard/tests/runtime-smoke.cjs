// Explicit full-runtime gate: npm test -- tests/runtime-smoke.cjs
// Requires AFG_N8N_BINARY pointing to a separately installed, pinned n8n runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function resultJson(output) {
  for (let start = output.indexOf('{'); start !== -1; start = output.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < output.length; i++) {
      const c = output[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const value = JSON.parse(output.slice(start, i + 1)); if (value.data?.resultData) return value; } catch {}
        break;
      }
    }
  }
  throw new Error(`n8n did not return execution data: ${output.slice(-5000)}`);
}

test('packed Community Node installs and executes real n8n workflows', { timeout: 240000 }, async () => {
  assert.ok(process.env.AFG_N8N_BINARY, 'AFG_N8N_BINARY must point to n8n 2.49.6');
  const runtime = fs.realpathSync(process.env.AFG_N8N_BINARY);
  const runtimeRoot = path.dirname(path.dirname(runtime));
  const root = path.resolve(__dirname, '..');
  const repo = path.resolve(root, '../..');
  const binary = path.join(repo, 'target/debug/afg');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'afg-n8n-runtime-'));
  const home = path.join(temp, 'user');
  const project = path.join(temp, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const policy = path.join(project, 'agentforge.yaml');
  const original = fs.readFileSync(path.join(repo, 'crates/afg-core/policies/default.yaml'));
  fs.writeFileSync(policy, original);
  const key = 'FAKE-n8n-runtime-test-key-000000000000';
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    NODE_PATH: [path.dirname(runtimeRoot), path.join(runtimeRoot, 'node_modules')].join(path.delimiter),
    N8N_USER_FOLDER: home,
    N8N_ENCRYPTION_KEY: 'FAKE-n8n-runtime-encryption-key-0000000000000',
    N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
    AFG_GATEWAY_API_KEY: key,
  };
  const run = (program, args, cwd = temp) => {
    const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  };
  const checked = (program, args, cwd) => {
    const result = run(program, args, cwd);
    assert.equal(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const explained = JSON.parse(checked(binary, ['policy', 'explain', '--json', '--', 'git', 'status'], project));
  const gateway = spawn(binary, ['gateway', '--listen', '127.0.0.1:0', '--policy-hash', explained.policyHash], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let jef;
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Gateway startup timed out')), 10000);
      gateway.once('error', error => { clearTimeout(timer); reject(error); });
      gateway.once('exit', code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${output}`)); });
      gateway.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/listening on (127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); }
      });
    });
    const published = process.env.AFG_N8N_PACKAGE;
    if (published) assert.match(published, /^n8n-nodes-agentforge-guard@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
    const packArgs = ['pack', ...(published ? [published] : ['--offline']), '--json', '--ignore-scripts', '--pack-destination', temp];
    const [packed] = JSON.parse(checked('npm', packArgs, root));
    const nodesDir = path.join(home, '.n8n/nodes');
    fs.mkdirSync(nodesDir, { recursive: true });
    checked('npm', ['install', '--prefix', nodesDir, ...(published ? [] : ['--offline']), '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', published || path.join(temp, packed.filename)]);
    if (published) checked('npm', ['audit', 'signatures', '--prefix', nodesDir]);
    const installed = JSON.parse(fs.readFileSync(path.join(nodesDir, 'node_modules/n8n-nodes-agentforge-guard/package.json')));
    assert.equal(installed.version, '0.1.0');
    const credentialsFile = path.join(temp, 'fake-credentials.json');
    const importCredentials = apiKey => {
      fs.writeFileSync(credentialsFile, JSON.stringify([{ id: 'afgRuntimeCredential', name: 'FAKE test credential', type: 'agentForgeGuardApi', data: { baseUrl, apiKey } }]));
      checked(runtime, ['import:credentials', `--input=${credentialsFile}`]);
    };
    importCredentials(key);
    let sequence = 0;
    const execute = (template, argv, operation) => {
      const workflow = JSON.parse(fs.readFileSync(path.join(root, 'workflows', template)));
      workflow.id = `afgRuntimeFlow${String(++sequence).padStart(2, '0')}`;
      workflow.versionId = randomUUID();
      const guard = workflow.nodes.find(n => n.type === 'n8n-nodes-agentforge-guard.agentForgeGuard');
      guard.parameters.argv = JSON.stringify(argv);
      if (operation) Object.assign(guard.parameters, operation);
      guard.credentials = { agentForgeGuardApi: { id: 'afgRuntimeCredential', name: 'FAKE test credential' } };
      const jefNode = workflow.nodes.find(n => n.type === 'n8n-nodes-jef.jef');
      if (jefNode) jefNode.credentials = { jefApi: { id: 'afgJefCredential', name: 'FAKE JEF test credential' } };
      const file = path.join(temp, `workflow-${sequence}.json`);
      fs.writeFileSync(file, JSON.stringify(workflow));
      checked(runtime, ['import:workflow', `--input=${file}`]);
      const result = run(runtime, ['execute', `--id=${workflow.id}`, '--rawOutput']);
      const data = resultJson(`${result.stdout}\n${result.stderr}`).data.resultData;
      return { data, guard: guard.name };
    };
    for (const [argv, expected] of [[['git', 'status'], 'allow'], [['terraform', 'destroy'], 'deny'], [['kubectl', 'apply'], 'require-approval'], [['sh', '-c', 'touch MUST_NOT_EXIST'], 'route']]) {
      const { data, guard } = execute('policy-gate.json', argv);
      const item = data.runData[guard]?.[0]?.data?.main?.[0]?.[0]?.json;
      assert.equal(item?.effect, expected, JSON.stringify(data));
      assert.equal(item.policyHash, explained.policyHash);
      assert.equal(Boolean(data.error), expected !== 'allow');
      assert.equal(Boolean(data.runData['Allowed - re-evaluate with afg run before execution']), expected === 'allow');
    }
    for (const argv of [['terraform', 'destroy'], ['kubectl', 'apply'], ['sh', '-c', 'echo example']]) {
      const { data } = execute('security-validate.json', argv);
      assert.ok(data.error, 'Security Validate must stop every non-allow effect');
      assert.ok(!data.runData['Reached only after allow']);
    }
    const { data: allowed } = execute('security-validate.json', ['git', 'status']);
    assert.ok(!allowed.error);
    assert.ok(allowed.runData['Reached only after allow']);
    const { data: analyze, guard } = execute('command-analyze.json', ['sh', '-c', 'echo example']);
    assert.ok(!analyze.error);
    assert.equal(analyze.runData[guard][0].data.main[0][0].json.effect, 'route');
    fs.writeFileSync(policy, 'invalid policy');
    assert.ok(execute('policy-gate.json', ['git', 'status']).data.error);
    fs.writeFileSync(policy, original);
    importCredentials('FAKE-wrong-runtime-test-key-000000000');
    assert.ok(execute('policy-gate.json', ['git', 'status']).data.error);
    importCredentials(key);
    checked('npm', ['install', '--prefix', nodesDir, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', 'n8n-nodes-jef@0.2.0-rc.4']);
    const jefRequests = path.join(temp, 'jef-requests.jsonl');
    jef = spawn(process.execPath, [path.join(__dirname, 'fixtures/jef-contract-server.cjs'), jefRequests], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const jefUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('JEF fixture startup timeout')), 10000);
      jef.once('error', error => { clearTimeout(timer); reject(error); });
      jef.stdout.on('data', chunk => { const match = String(chunk).match(/listening on (127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); } });
    });
    fs.writeFileSync(credentialsFile, JSON.stringify([{ id: 'afgJefCredential', name: 'FAKE JEF test credential', type: 'jefApi', data: { baseUrl: jefUrl, apiKey: 'FAKE-JEF-contract-test-key-0000000000' } }]));
    checked(runtime, ['import:credentials', `--input=${credentialsFile}`]);
    for (const argv of [['terraform', 'destroy'], ['kubectl', 'apply'], ['sh', '-c', 'echo example']]) {
      const { data } = execute('jef-incident-review.json', argv);
      assert.ok(data.error, 'JEF must never override the Guard decision');
      assert.ok(data.runData['JEF - recommend a human review team']);
      assert.ok(data.runData['Stop - JEF cannot override Guard']);
      assert.ok(!data.runData['Allowed - re-evaluate with afg run before execution']);
    }
    const requests = fs.readFileSync(jefRequests, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(r => r.state.effect), ['deny', 'require-approval', 'route']);
    assert.ok(requests.every(r => Object.keys(r.state).sort().join(',') === 'effect,policyHash,ruleId,source'));
    assert.ok(!execute('jef-incident-review.json', ['git', 'status']).data.error);
    assert.equal(fs.readFileSync(jefRequests, 'utf8').trim().split('\n').length, 3, 'allow does not send incidents');
    assert.ok(!fs.existsSync(path.join(project, 'MUST_NOT_EXIST')));
    console.log('n8n runtime: installed tarball, four decisions, validation, analyze, policy change and authentication verified');
  } finally {
    if (jef) jef.kill('SIGINT');
    gateway.kill('SIGINT');
    await new Promise(resolve => { gateway.once('exit', resolve); setTimeout(() => { gateway.kill('SIGKILL'); resolve(); }, 2000).unref(); });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
