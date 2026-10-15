import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsEmail } from '../src/email-policy.ts';

test('direct email sign-in uses exact provider domains', () => {
  assert.equal(allowsEmail(' person@GMAIL.COM '), true);
  for (const value of ['person@gmail.com.evil.invalid', 'person@sub.gmail.com', 'person@custom.invalid', 'person@@qq.com', '@qq.com', null])
    assert.equal(allowsEmail(value), false);
});
