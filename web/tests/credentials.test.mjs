import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCredentialInput, createCredentialMemory } from '../src/credentials.mjs';

const token = 'gw_' + 'a'.repeat(43);
test('accepts a complete gateway credential and trims pasted whitespace', () => {
  assert.deepEqual(projectCredentialInput('\n ' + token + '  '), { token, error: '' });
  assert.equal(projectCredentialInput('gw_' + '-_A'.repeat(14) + '0').error, '');
});
test('explains missing, wrong-type, and incomplete credentials', () => {
  assert.match(projectCredentialInput(' ').error, /选择项目并填入/);
  for (const value of ['admin-password', 'sk_provider', '...']) assert.match(projectCredentialInput(value).error, /不是管理密码或厂商 Token/);
  for (const value of ['gw_', 'gw_…', token.slice(0, -1), token + 'x', token.slice(0, -1) + '!']) assert.match(projectCredentialInput(value).error, /不完整/);
});
test('generated credentials stay scoped to page memory and are replaceable and revocable', () => {
  const memory = createCredentialMemory();
  memory.remember('project-a', token);
  memory.remember('project-b', 'invalid');
  assert.equal(memory.get('project-a'), token);
  assert.equal(memory.get('project-b'), undefined);
  assert.equal(createCredentialMemory().get('project-a'), undefined);
  const rotated = 'gw_' + 'b'.repeat(43);
  memory.remember('project-a', rotated);
  memory.forgetToken(token);
  assert.equal(memory.get('project-a'), rotated);
  memory.forgetToken(rotated);
  assert.equal(memory.get('project-a'), undefined);
  memory.remember('project-a', token);
  memory.clear();
  assert.equal(memory.get('project-a'), undefined);
});
