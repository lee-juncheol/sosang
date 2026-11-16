import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSETS, replaceSpan } from '../scripts/github-release.mjs';

test('release text updates every copy of one platform and leaves the others alone', () => {
  const body = [
    'Mac <!--darwin-aarch64-->**0.1.0**<!--/darwin-aarch64--> Windows <!--windows-x86_64-->**0.1.1**<!--/windows-x86_64-->',
    '맥 <!--darwin-aarch64-->**0.1.0**<!--/darwin-aarch64--> 윈도우 <!--windows-x86_64-->**0.1.1**<!--/windows-x86_64-->',
    'sha <!--windows-x86_64:sha-->old<!--/windows-x86_64:sha-->',
  ].join('\n');
  let out = replaceSpan(body, 'windows-x86_64', '**0.1.2**');
  out = replaceSpan(out, 'windows-x86_64:sha', 'abc');
  assert.equal(out.match(/\*\*0\.1\.2\*\*/g).length, 2);
  assert.equal(out.match(/\*\*0\.1\.0\*\*/g).length, 2, 'the Mac lines are untouched');
  assert.match(out, /<!--windows-x86_64:sha-->abc<!--\/windows-x86_64:sha-->/);
  assert.throws(() => replaceSpan(body, 'linux-x86_64', 'x'), /no <!--linux-x86_64-->/);
});

test('every release platform has a fixed download name', () => {
  assert.deepEqual(Object.keys(ASSETS).sort(), ['darwin-aarch64', 'windows-x86_64']);
  for (const name of Object.values(ASSETS)) assert.doesNotMatch(name, /\d+\.\d+\.\d+/, 'no version in the asset name');
});
