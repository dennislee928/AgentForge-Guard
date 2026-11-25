// Contract fixture, not a JEF inference engine. Only fake credentials are used.
const http = require('node:http');
const fs = require('node:fs');
const key = 'FAKE-JEF-contract-test-key-0000000000';
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/systemone' || request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401).end();
    return;
  }
  let raw = '';
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  fs.appendFileSync(process.argv[2], `${JSON.stringify(body)}\n`);
  if (body.state?.source !== 'AgentForge Guard' || body.questions?.review_owner?.type !== 'choice') {
    response.writeHead(422).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ answers: { review_owner: { type: 'choice', choice: 'soc', confidence: 0.9, probabilities: { soc: 0.9, appsec: 0.05, infra: 0.05 } } }, usage: { inputTokens: 1, outputTokens: 0 } }));
});
server.listen(0, '127.0.0.1', () => console.log(`JEF fixture listening on 127.0.0.1:${server.address().port}`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
