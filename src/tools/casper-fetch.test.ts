import { strict as assert } from 'node:assert';
import { afterEach, after, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WCSPR_ASSETS } from '../casper/accepts.js';
const dir = mkdtempSync(join(tmpdir(), 'x402-test-'));
const env = { ...process.env };
process.env.PAYMENT_LOG_PATH = join(dir, 'ledger.jsonl');
const { registerFetchTool } = await import('./fetch.js');
const { boundedText } = await import('./casper-fetch.js');
const { logPayment, getDailySpent } = await import('../payment-utils.js');
const { casperBudget } = await import('../casper/budget.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...env, PAYMENT_LOG_PATH: join(dir, 'ledger.jsonl') }; });
after(() => { process.env = env; rmSync(dir, {recursive:true, force:true}); });
function handler() {
  let callback: any;
  registerFetchTool({ tool: (_n: unknown, _d: unknown, _s: unknown, fn: unknown) => { callback = fn; } } as any);
  return callback;
}
const offer = { scheme: 'exact', network: 'casper:casper', asset: WCSPR_ASSETS['casper:casper'], payTo: '00'+'ab'.repeat(32), amount: '1000000000', maxTimeoutSeconds: 60, extra: { name: 'Wrapped CSPR', version: '1' } };
function challenge(changes={}) {
  const payload = JSON.stringify({x402Version:2, resource:{url:'https://example.invalid',description:'',mimeType:'text/plain'},accepts:[{...offer,...changes}]});
  return new Response(payload,{status:402,headers:{'payment-required':Buffer.from(payload).toString('base64')}});
}
it('forced Casper probes and refuses unset budgets before any paid request', async () => {
  delete process.env.CASPER_MAX_PAYMENT_PER_CALL; delete process.env.CASPER_MAX_DAILY_SPEND;
  process.env.CASPER_PRIVATE_KEY = '11'.repeat(32);
  let calls=0; globalThis.fetch=async () => {calls++; return challenge();};
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/disabled/); assert.equal(calls,1);
});
it('forced Casper refuses absent offers instead of a default price', async () => {
  globalThis.fetch=async () => new Response(JSON.stringify({accepts:[]}),{status:402});
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/No matching/);
});
it('actual SDK challenge cannot increase price beyond the checked limit', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1'; process.env.CASPER_MAX_DAILY_SPEND='10'; process.env.CASPER_PRIVATE_KEY='11'.repeat(32);
  let calls=0;
  globalThis.fetch=async input => {calls++; if(input instanceof Request) assert.equal(input.headers.has('payment-signature'),false); return challenge({amount:calls===1?'1000000000':'2000000000'});};
  const before=casperBudget.getDailySpent();
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/failed/); assert.equal(calls,2); assert.equal(casperBudget.getDailySpent(),before);
});
it('sub-mote budgets are hard rejected through the real tool', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1.0000000001'; process.env.CASPER_MAX_DAILY_SPEND='10';
  let calls=0; globalThis.fetch=async () => {calls++;return challenge();};
  const result=await handler()({url:'https://example.invalid',chain:'casper'});
  assert.match(result.content[0].text,/sub-mote/); assert.equal(calls,1);
});
it('valid offer signs with the real SDK and records exact motes', async () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='1'; process.env.CASPER_MAX_DAILY_SPEND='10'; process.env.CASPER_PRIVATE_KEY='11'.repeat(32);
  let calls=0;
  globalThis.fetch=async (input, init) => {
    calls++;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (calls <= 2) return challenge();
    const payload = JSON.parse(Buffer.from(headers.get('payment-signature')!, 'base64').toString());
    assert.equal(payload.payload.authorization.value, '1000000000');
    assert.ok(payload.payload.signature.length > 0);
    return new Response('{"ok":true}', {status:200, headers:{'payment-response':Buffer.from(JSON.stringify({success:true, transaction:'ab'.repeat(32), network:'casper:casper'})).toString('base64')}});
  };
  const before=casperBudget.getDailySpent();
  const result=JSON.parse((await handler()({url:'https://example.invalid',chain:'casper'})).content[0].text);
  assert.equal(result.paid,true); assert.equal(calls,3);
  assert.equal(casperBudget.getDailySpent(),before+1000000000n);
  assert.equal(result.authorized_motes,'1000000000');
});
it('streaming payment bodies are bounded', async () => {
  await assert.rejects(boundedText(new Response('a'.repeat(65537))),/size limit/);
});
it('Casper and USD counters remain independent in one ledger', () => {
  process.env.CASPER_MAX_PAYMENT_PER_CALL='2'; process.env.CASPER_MAX_DAILY_SPEND='10';
  const usd=getDailySpent(), motes=casperBudget.getDailySpent();
  casperBudget.reserve(1n);
  logPayment({timestamp:new Date().toISOString(),url:'https://example.invalid',method:'GET',chain:'casper',currency:'wCSPR',amount_motes:'1',status:'success'});
  assert.equal(getDailySpent(),usd); assert.equal(casperBudget.getDailySpent(),motes+1n);
  logPayment({timestamp:new Date().toISOString(),url:'https://example.invalid',method:'GET',chain:'base',amount_usdc:0.01,status:'success'});
  assert.equal(getDailySpent(),usd+0.01); assert.equal(casperBudget.getDailySpent(),motes+1n);
  const rows=readFileSync(join(dir,'ledger.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows.slice(-2).map(row=>row.chain),['casper','base']);
  assert.equal(rows.at(-2).amount_usdc,undefined); assert.equal(rows.at(-2).amount_motes,'1');
});
