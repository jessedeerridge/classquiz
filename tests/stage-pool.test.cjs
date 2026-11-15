const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const start = html.indexOf('async function ensureStagePool(');
  const end = html.indexOf('function optionDisplayForWord(', start);
  const pending = [];
  let builds = 0;
  const context = vm.createContext({
    STUDENT: { studentKey: 'test-student' },
    QUIZ_SESSION_RULES: { randomStageSize: 30 },
    getEmbeddedStageWords: () => [],
    fillStageWordsFromPrevious: () => {
      builds++;
      return [{ id: String(builds), word: 'word', meaning: 'answer', wrongs: ['other'] }];
    },
    getCachedStageProgress: () => ({}),
    setCachedStageProgress: () => {},
    splitTextAndFurigana: text => ({ text }),
    P: { progressStage: (...parts) => parts.join('/') },
    dbGet: () => new Promise(resolve => pending.push(resolve)),
  });
  vm.runInContext(`let STAGE_POOL = null; let stagePoolLoad = null;
    ${html.slice(start, end)}
    globalThis.load = ensureStagePool;
    globalThis.pool = () => STAGE_POOL;`, context);
  return { context, pending, builds: () => builds };
}

test('concurrent requests share one randomized word pool', async () => {
  const f = fixture();
  const requests = Array.from({ length: 10 }, () => f.context.load(1, '5', 'pre1'));
  assert.equal(f.builds(), 1);
  f.pending[0](null);
  const pools = await Promise.all(requests);
  assert.ok(pools.every(pool => pool === pools[0]));
  assert.equal(await f.context.load(1, '5', 'pre1'), pools[0]);
  assert.equal(f.builds(), 1);
});

test('a late result cannot overwrite a newly selected stage', async () => {
  const f = fixture();
  const old = f.context.load(1, '5', 'pre1');
  const rejected = assert.rejects(old, /stage_changed/);
  const current = f.context.load(1, '5', 'pre2');
  f.pending[1](null);
  const expected = await current;
  f.pending[0](null);
  await rejected;
  assert.equal(f.context.pool(), expected);
});

test('returning to a cached stage cancels another pending stage', async () => {
  const f = fixture();
  const first = f.context.load(1, '5', 'pre1');
  f.pending[0](null);
  const expected = await first;
  const other = f.context.load(2, '5', 'pre1');
  const rejected = assert.rejects(other, /stage_changed/);
  assert.equal(await f.context.load(1, '5', 'pre1'), expected);
  f.pending[1](null);
  await rejected;
  assert.equal(f.context.pool(), expected);
});
