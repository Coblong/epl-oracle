import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyProviderFailure,providerFailureMessage} from '../lib/provider-errors.mjs';

test('provider failures map to safe diagnostic codes',()=>{
  assert.equal(classifyProviderFailure(Object.assign(new Error('Upstream request failed'),{status:429})),'http_429');
  assert.equal(classifyProviderFailure(new DOMException('sensitive timeout text','TimeoutError')),'timeout');
  assert.equal(classifyProviderFailure(Object.assign(new TypeError('sensitive network details'),{cause:{code:'ECONNRESET'}})),'network_error');
  assert.equal(classifyProviderFailure(Object.assign(new Error('private refusal text'),{failureCode:'provider_refusal'})),'provider_refusal');
  assert.equal(classifyProviderFailure(new SyntaxError('private response body')),'invalid_response');
  assert.equal(classifyProviderFailure(new Error('ANTHROPIC_API_KEY is not configured.')),'missing_credentials');
  assert.equal(classifyProviderFailure(new Error('contains a private token')),'provider_error');
});

test('diagnostic messages use the safe code only',()=>{
  assert.equal(providerFailureMessage('http_429'),'Provider returned HTTP 429.');
  assert.equal(providerFailureMessage('timeout'),'Provider request timed out.');
  assert.equal(providerFailureMessage('private token <script>'),'');
});
