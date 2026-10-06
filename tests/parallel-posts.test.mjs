import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import PostDownloader from '../dist/downloaders/PostDownloader.js';
import PostsFetcher from '../dist/downloaders/PostsFetcher.js';
import PostParser from '../dist/parsers/PostParser.js';
import DownloadTask from '../dist/downloaders/task/DownloadTask.js';
import { getDownloaderInit } from '../dist/downloaders/DownloaderOptions.js';
import { getCLIOptions } from '../dist/cli/CLIOptions.js';
import DateTime from '../dist/utils/DateTime.js';

function post(id) {
  return { type: 'post', id, postType: 'text_only', title: 'Post ' + id, isViewable: true,
    url: 'https://www.patreon.com/posts/' + id, content: 'Text', teaserText: null,
    publishedAt: '2024-01-01T00:00:00.000Z', editedAt: null, commentCount: 0,
    tiers: [], collections: [], tags: [], images: [], attachments: [], linkedAttachments: [],
    embed: null, coverImage: null, thumbnail: null, audio: null, audioPreview: null,
    video: null, videoPreview: null, campaign: null, raw: { id } };
}

class TestDownloader extends PostDownloader {
  async commonFetchAPI(url, signal) {
    const id = new URL(url).pathname.split('/').at(-1);
    await delay(15);
    if (signal?.aborted) return { json: null };
    if (id === this.failId) throw new Error('Test refresh failure');
    return { json: { items: [this.posts.find((p) => p.id === id)] } };
  }
  dirs(value) { return this.fsHelper.getPostDirs(value); }
  batch(name) { return this.createDownloadTaskBatch(name); }
  installWrites() {
    const original = this.fsHelper.writeTextFile.bind(this.fsHelper);
    this.fsHelper.writeTextFile = async (...args) => { await delay(20); return original(...args); };
  }
}

async function setup(t, options = {}, pages = [[post('1'), post('2'), post('3'), post('4')]]) {
  const root = options.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-post-test-'));
  if (!options.outDir) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let cursor = 0;
  t.mock.method(PostsFetcher.prototype, 'begin', () => Promise.resolve());
  t.mock.method(PostsFetcher.prototype, 'hasNext', () => cursor < pages.length);
  t.mock.method(PostsFetcher.prototype, 'next', async () => ({ list: { items: pages[cursor++], total: pages.flat().length }, aborted: false }));
  t.mock.method(PostsFetcher.prototype, 'getTotal', () => pages.flat().length);
  t.mock.method(PostParser.prototype, 'parsePostsAPIResponse', async (json) => ({ items: json.items }));
  const logs = [], timeline = [], saved = [];
  let active = 0, peak = 0;
  const config = { ...getDownloaderInit({ outDir: root, maxConcurrentPosts: 2,
    request: { minTime: 0, maxConcurrent: 2 },
    include: { contentInfo: true, contentMedia: false, previewMedia: false, comments: false },
    ...options }), type: 'post', targetURL: 'https://www.patreon.com/test/posts',
    postFetch: { type: 'byUser', vanity: 'test' } };
  const db = { saveContent: (p) => { saved.push(p.id); timeline.push('save:' + p.id); },
    getContent: () => null, saveCollection: (c) => timeline.push('collection:' + c.id),
    close: () => { assert.equal(active, 0); timeline.push('db-close'); } };
  const instance = new TestDownloader(config, () => Promise.resolve(db), {
    log: (entry) => logs.push(entry), end: () => { assert.equal(active, 0); timeline.push('logger-close'); return Promise.resolve(); }
  }, { skipSaveCampaign: true });
  instance.posts = pages.flat();
  instance.installWrites();
  instance.on('targetBegin', ({ target }) => {
    if (target.type !== 'post') return;
    active++; peak = Math.max(peak, active); timeline.push('begin:' + target.id);
  });
  instance.on('targetEnd', ({ target }) => {
    if (target.type !== 'post') return;
    active--; timeline.push('end:' + target.id);
  });
  instance.on('end', (event) => {
    if (event.aborted) active = 0;
    timeline.push('finish:' + event.aborted);
  });
  return { instance, root, logs, timeline, saved, peak: () => peak };
}

test('post workers overlap and preserve results across pages', async (t) => {
  const run = await setup(t, {}, [[post('1'), post('2'), post('3')], [post('4'), post('5')]]);
  await run.instance.doStart();
  assert.equal(run.peak(), 2);
  assert.deepEqual([...run.saved].sort(), ['1', '2', '3', '4', '5']);
  assert.ok(run.timeline.indexOf('begin:2') < run.timeline.indexOf('end:1'));
  assert.ok(run.logs.some((e) => e.message.join(' ').includes('Total 5 / 5 posts processed')));
  assert.deepEqual(run.timeline.slice(-3), ['finish:false', 'db-close', 'logger-close']);
});

test('one worker remains serial and duplicate IDs are processed once', async (t) => {
  const run = await setup(t, { maxConcurrentPosts: 1 }, [[post('1'), post('2')], [post('1'), post('3')]]);
  await run.instance.doStart();
  assert.equal(run.peak(), 1);
  assert.deepEqual(run.saved, ['1', '2', '3']);
});

for (const stopOn of ['previouslyDownloaded', 'postPreviouslyDownloaded', 'publishDateOutOfRange', 'postPublishDateOutOfRange']) {
  test('stop condition ' + stopOn + ' allows configured post concurrency', async (t) => {
    const run = await setup(t, { maxConcurrentPosts: 3, stopOn });
    await run.instance.doStart();
    assert.equal(run.peak(), 3);
    if (stopOn.includes('Downloaded')) {
      const rerun = await setup(t, { maxConcurrentPosts: 3, stopOn, outDir: run.root });
      await rerun.instance.doStart();
      assert.deepEqual(rerun.saved, []);
      assert.ok(rerun.timeline.filter((s) => s.startsWith('begin:')).length > 1);
    }
  });
}

test('publish-date stop allows already scheduled concurrent posts to finish', async (t) => {
  const run = await setup(t, { maxConcurrentPosts: 3, stopOn: 'publishDateOutOfRange',
    include: { postsPublished: { after: DateTime.from('2025-01-01') } } });
  await run.instance.doStart();
  assert.equal(run.timeline.filter((s) => s.startsWith('begin:')).length, 3);
  assert.deepEqual(run.saved, []);
});

test('collections save once and the shared cache retains every post', async (t) => {
  const posts = Array.from({ length: 8 }, (_, i) => post(String(i + 1)));
  for (const p of posts) {
    p.campaign = { id: 'campaign', name: 'Campaign', creator: { id: 'creator', vanity: 'creator' } };
    p.collections = [{ type: 'collection', id: 'shared', title: 'Shared', thumbnail: null, raw: {} }];
  }
  const run = await setup(t, { maxConcurrentPosts: 8 }, [posts]);
  await run.instance.doStart();
  assert.equal(run.timeline.filter((s) => s === 'collection:shared').length, 1);
  const cache = JSON.parse(fs.readFileSync(path.join(run.instance.dirs(posts[0]).statusCache, 'status-cache.json'), 'utf8'));
  assert.equal(Object.keys(cache.posts).length, 8);
});

test('colliding directories serialize save operations', async (t) => {
  const posts = [post('1'), post('2')];
  posts.forEach((p) => { p.url = 'https://www.patreon.com/posts/same-slug-1'; });
  const run = await setup(t, { dirNameFormat: { content: '{content.slug}' } }, [posts]);
  assert.equal(run.instance.dirs(posts[0]).root, run.instance.dirs(posts[1]).root);
  let active = 0, peak = 0;
  run.instance.on('phaseBegin', ({ target, phase }) => {
    if (target.type === 'post' && phase === 'saveInfo') { active++; peak = Math.max(peak, active); }
  });
  run.instance.on('phaseEnd', ({ target, phase }) => { if (target.type === 'post' && phase === 'saveInfo') active--; });
  await run.instance.doStart();
  assert.deepEqual(run.saved, ['1', '2']);
  assert.equal(peak, 1);
});

test('post batches use independent media task concurrency limits', async (t) => {
  const run = await setup(t);
  let active = 0, peak = 0;
  class SlowTask extends DownloadTask {
    name = 'SlowTask';
    async resolveDestPath() { return path.join(run.root, this.srcEntity.id); }
    async doStart() { this.notifyStart(); active++; peak = Math.max(peak, active); await delay(100); active--; this.notifyComplete(); }
    async doAbort() { this.notifyAbort(); }
    async doDestroy() {}
    doGetProgress() { return null; }
  }
  const batches = await Promise.all([run.instance.batch('one'), run.instance.batch('two')]);
  for (const [i, { batch }] of batches.entries()) {
    batch.addTasks(await Promise.all([0, 1, 2].map((j) => DownloadTask.create(SlowTask, {
      src: 'http://example.test', srcEntity: { id: i + '-' + j, type: 'image' },
      config: run.instance.getConfig(false), downloadType: 'variant', callbacks: null
    }))));
  }
  await Promise.all(batches.map(({ batch }) => batch.start()));
  assert.equal(peak, 4);
  await Promise.all(batches.map(({ batch }) => batch.destroy()));
});

test('cancellation stops scheduling and precedes shared resource shutdown', async (t) => {
  const run = await setup(t);
  const controller = new AbortController();
  run.instance.once('targetBegin', () => controller.abort());
  await run.instance.doStart({ signal: controller.signal });
  assert.ok(run.timeline.filter((s) => s.startsWith('begin:')).length <= 2);
  assert.deepEqual(run.saved, []);
  assert.deepEqual(run.timeline.slice(-3), ['finish:true', 'db-close', 'logger-close']);
});

test('worker errors settle active work before resource shutdown', async (t) => {
  const run = await setup(t);
  run.instance.failId = '1';
  await assert.rejects(run.instance.doStart(), /Test refresh failure/);
  assert.deepEqual(run.saved, []);
  assert.deepEqual(run.timeline.slice(-2), ['db-close', 'logger-close']);
});

for (const cancel of [false, true]) {
  test('real concurrent attachment transfers ' + (cancel ? 'settle on cancellation' : 'finish with intact files'), async (t) => {
    const controller = new AbortController();
    let active = 0, peak = 0;
    const body = Buffer.alloc(4096, 'x');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      if (req.method === 'HEAD') { res.end(); return; }
      active++; peak = Math.max(peak, active);
      const timer = setTimeout(() => res.end(body), 180);
      res.on('close', () => { clearTimeout(timer); active--; });
      if (cancel && active === 2) setTimeout(() => controller.abort(), 30);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const posts = [post('1'), post('2'), post('3'), post('4')];
    for (const p of posts) p.attachments = [{ type: 'attachment', id: 'file-' + p.id,
      filename: 'file-' + p.id + '.bin', mimeType: 'application/octet-stream', downloadURL: origin + '/' + p.id }];
    const run = await setup(t, { include: { contentInfo: false, contentMedia: true, previewMedia: false, comments: false } }, [posts]);
    const batches = [];
    run.instance.on('phaseBegin', ({ phase, batch }) => { if (phase === 'batchDownload') batches.push(batch); });
    await run.instance.doStart({ signal: controller.signal });
    await delay(30);
    assert.equal(peak, 2);
    assert.equal(active, 0);
    assert.ok(batches.every((batch) => batch.isDestroyed()));
    if (cancel) {
      assert.deepEqual(run.saved, []);
      assert.equal(batches.length, 2);
      assert.deepEqual(run.timeline.slice(-3), ['finish:true', 'db-close', 'logger-close']);
    }
    else {
      assert.deepEqual([...run.saved].sort(), ['1', '2', '3', '4']);
      for (const p of posts) {
        const dir = run.instance.dirs(p).attachments;
        const files = fs.readdirSync(dir);
        assert.equal(files.length, 1);
        assert.deepEqual(fs.readFileSync(path.join(dir, files[0])), body);
      }
    }
  });
}

test('post concurrency defaults and library validation', () => {
  assert.equal(getDownloaderInit().maxConcurrentPosts, 1);
  assert.equal(getDownloaderInit({ maxConcurrentPosts: 4 }).maxConcurrentPosts, 4);
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => getDownloaderInit({ maxConcurrentPosts: value }), /positive integer/);
});

test('CLI and config expose post concurrency with strict validation', (t) => {
  const original = process.argv;
  t.after(() => { process.argv = original; });
  process.argv = ['node', 'patreon-dl', '--max-concurrent-posts', '3'];
  assert.equal(getCLIOptions(true).maxConcurrentPosts, 3);
  for (const value of ['0', '-1', '1.5', '2junk']) {
    process.argv = ['node', 'patreon-dl', '--max-concurrent-posts=' + value];
    assert.throws(() => getCLIOptions(true), /positive integer/);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.conf');
  fs.writeFileSync(file, '[downloader]\nmax.concurrent.posts = 4\n');
  process.argv = ['node', 'patreon-dl', '-C', file];
  assert.equal(getCLIOptions(true).maxConcurrentPosts, 4);
  process.argv.push('--max-concurrent-posts', '2');
  assert.equal(getCLIOptions(true).maxConcurrentPosts, 2);
});
