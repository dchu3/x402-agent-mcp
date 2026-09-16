import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { isCasperNetwork } from './networks.js';
import { findCasperAccepts, selectCasperAccept } from './accepts.js';

it('rejects invented Casper networks', () => {
  assert.equal(isCasperNetwork('casper:evil'), false);
});
it('rejects scheme-less offers', () => {
  assert.deepEqual(findCasperAccepts({accepts: [{network: 'casper:casper'}]}), []);
});
it('does not fall back across an explicit network boundary', () => {
  assert.equal(selectCasperAccept({accepts: [{scheme: 'exact', network: 'casper:casper-test'}]}, 'casper:casper'), undefined);
});
