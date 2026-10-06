import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { planHLSPlaylist } from '../dist/downloaders/task/HLSPlaylist.js';
import M3U8DownloadTask from '../dist/downloaders/task/M3U8DownloadTask.js';
import Fetcher from '../dist/utils/Fetcher.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-hls-test-'));
const routes = new Map();
let active = 0;
let peak = 0;
const requests = [];
const server = http.createServer((req, res) => {
  const route = routes.get(req.url);
  requests.push({ url: req.url, range: req.headers.range });
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  if (route.location) {
    res.writeHead(302, { Location: route.location }).end();
    return;
  }
  active++;
  peak = Math.max(peak, active);
  res.on('close', () => active--);
  setTimeout(() => {
    const body = route.body || route;
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (range && !route.ignoreRange) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}` }).end(body.subarray(start, end + 1));
    }
    else res.writeHead(200).end(body);
  }, route.delay || 20);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { encoding: 'utf8', cwd });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

function fixture(name, type = 'mpegts', extra = []) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const playlist = path.join(dir, 'media.m3u8');
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-g', '10',
    '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', type,
    ...extra, playlist], dir);
  for (const file of fs.readdirSync(dir)) routes.set(`/${name}/${file}`, fs.readFileSync(path.join(dir, file)));
  return { dir, contents: fs.readFileSync(playlist, 'utf8'), src: `${origin}/${name}/media.m3u8` };
}

const ts = fixture('ts');
const fmp4 = fixture('fmp4', 'fmp4');
const rangedTs = fixture('ranged-ts', 'mpegts', ['-hls_flags', 'single_file']);
const rangedMp4 = fixture('ranged-mp4', 'fmp4', ['-hls_flags', 'single_file']);
const videoOnly = fixture('video-only', 'fmp4', ['-an']);
const audioOnly = fixture('audio-only', 'fmp4', ['-vn']);
const ac3 = fixture('ac3', 'mpegts', ['-c:a', 'ac3']);

class ExposedTask extends M3U8DownloadTask {
  prepare(params, context) { return this.prepareFFmpegCommandParams(params, context); }
  select() { return this.getFFmpegCommandParams(); }
}

function task(src, overrides = {}) {
  const config = { dryRun: false, request: { maxConcurrent: 2, maxRetries: 0, userAgent: 'hls-test' },
    include: { protectedMedia: false }, outDir: root, ...overrides };
  const logs = [];
  const instance = new ExposedTask({ src, srcEntity: { id: 'test', type: 'video', duration: 3 }, config,
    destFilePath: path.join(root, 'output.mp4'), fileExistsAction: 'overwrite', downloadType: 'main',
    callbacks: null, fetcher: new Fetcher(config), logger: { log: (entry) => logs.push(entry) } });
  instance.logs = logs;
  return instance;
}

async function prepare(src, signal) {
  const instance = task(src);
  const params = { inputs: [{ input: src, parallelSegmentDownloadSrc: src }], output: path.join(root, 'out.mp4') };
  const prepared = await instance.prepare(params, { tmpFilePath: path.join(root, 'output.tmp.mp4'), signal });
  assert.equal(prepared.noProxy, true, `parallel flow should be used: ${instance.logs.map((e) => e.message.join(' ')).join('\n')}`);
  return prepared;
}

function probe(prepared, name) {
  const output = path.join(root, `${name}.mp4`);
  const { input, options } = prepared.inputs[0];
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...options, '-i', input, '-c', 'copy', ...(prepared.outputOptions || []).flatMap((option) => option.split(' ')), '-y', output]);
  const info = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
  assert.ok(info.streams.some((s) => s.codec_type === 'video'));
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  assert.ok(Number(info.format.duration) >= 2.9);
  return output;
}

function assertDecodedMatch(output, reference = path.join(root, 'ts-remux.mp4')) {
  for (const stream of ['v:0', 'a:0']) {
    const args = (input) => ['-v', 'error', '-i', input, '-map', `0:${stream}`, '-f', 'hash', '-hash', 'sha256', '-'];
    assert.equal(command('ffmpeg', args(output)), command('ffmpeg', args(reference)), `decoded ${stream} content must match`);
  }
}

test('static TS downloads concurrently and remuxes from a local playlist', async () => {
  peak = 0;
  const prepared = await prepare(ts.src);
  try {
    assert.equal(peak, 2);
    probe(prepared, 'ts-remux');
  }
  finally { prepared.cleanup(); }
  assert.equal(fs.existsSync(prepared.inputs[0].input), false);
});

test('fMP4 initialization maps download once and remux correctly', async () => {
  const plan = planHLSPlaylist(fmp4.contents, fmp4.src);
  assert.equal(plan.resources.filter((r) => r.filename.endsWith('.mp4')).length, 1);
  const prepared = await prepare(fmp4.src);
  try { probe(prepared, 'fmp4-remux'); }
  finally { prepared.cleanup(); }
});

test('discontinuity metadata and extensionless segment URLs are supported', async () => {
  let contents = ts.contents;
  for (const [index, segment] of Array.from(ts.contents.matchAll(/^media\d+\.ts$/gm)).entries()) {
    const uri = `opaque-${index}?token=example`;
    routes.set(`/ts/${uri}`, routes.get(`/ts/${segment[0]}`));
    contents = contents.replace(segment[0], `${index === 1 ? '#EXT-X-DISCONTINUITY\n' : ''}${uri}`);
  }
  routes.set('/ts/opaque.m3u8', contents);
  const prepared = await prepare(`${origin}/ts/opaque.m3u8`);
  try {
    assert.match(fs.readFileSync(prepared.inputs[0].input, 'utf8'), /#EXT-X-DISCONTINUITY\n/);
    probe(prepared, 'opaque-remux');
  }
  finally { prepared.cleanup(); }
});

test('live playlists fall back with no temporary inputs', async () => {
  routes.set('/live.m3u8', ts.contents.replace('#EXT-X-ENDLIST', ''));
  const src = `${origin}/live.m3u8`;
  const instance = task(src);
  const params = { inputs: [{ input: src, parallelSegmentDownloadSrc: src }], output: 'unused' };
  assert.equal(await instance.prepare(params, { tmpFilePath: path.join(root, 'live.tmp.mp4') }), params);
  assert.throws(() => planHLSPlaylist(ts.contents.replace('#EXT-X-ENDLIST', ''), src), /not static/);
});

test('TS byte ranges, including implicit offsets, download the requested bytes', async () => {
  const contents = rangedTs.contents.replace(/(#EXT-X-BYTERANGE:\d+)@(\d+)/g, (line, tag, offset) => offset === '0' ? line : tag);
  routes.set('/ranged-ts/implicit.m3u8', contents);
  const plan = planHLSPlaylist(contents, rangedTs.src);
  assert.ok(plan.resources.every((r) => r.byteRange));
  assert.ok(plan.resources[1].byteRange.offset > 0);
  const prepared = await prepare(`${origin}/ranged-ts/implicit.m3u8`);
  try {
    assert.doesNotMatch(fs.readFileSync(prepared.inputs[0].input, 'utf8'), /BYTERANGE/);
    probe(prepared, 'ranged-ts-remux');
  }
  finally { prepared.cleanup(); }
});

test('fMP4 byte ranges include the initialization map', async () => {
  const prepared = await prepare(rangedMp4.src);
  try { probe(prepared, 'ranged-mp4-remux'); }
  finally { prepared.cleanup(); }
});

test('invalid implicit ranges and servers ignoring Range safely fall back', async () => {
  assert.throws(() => planHLSPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\na.ts\n#EXT-X-ENDLIST', ts.src), /implicit byte range/);
  const original = routes.get('/ranged-ts/media.ts');
  routes.set('/ranged-ts/media.ts', { body: original, ignoreRange: true });
  const instance = task(rangedTs.src);
  const params = { inputs: [{ input: rangedTs.src, parallelSegmentDownloadSrc: rangedTs.src }], output: 'unused' };
  try {
    assert.equal(await instance.prepare(params, { tmpFilePath: path.join(root, 'range-fail.tmp.mp4') }), params);
    assert.ok(instance.logs.some((e) => e.message.some((m) => m instanceof Error && /requested byte range/.test(m.message))));
    assert.equal(fs.readdirSync(root).some((file) => file.startsWith('range-fail.tmp.mp4.hls-')), false);
  }
  finally { routes.set('/ranged-ts/media.ts', original); }
});

function encrypt(body, key, iv) {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(body), cipher.final()]);
}

test('AES-128 preserves implicit IVs, explicit IVs, key rotation, and METHOD=NONE', async () => {
  const key1 = randomBytes(16);
  const key2 = randomBytes(16);
  const explicitIv = Buffer.alloc(16, 7);
  routes.set('/aes/key1', key1);
  routes.set('/aes/key2', key2);
  let index = 0;
  const contents = ts.contents.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:37')
    .replace(/^media\d+\.ts$/gm, (uri) => {
      const current = index++;
      const localUri = `segment-${current}`;
      const body = routes.get(`/ts/${uri}`);
      let declaration;
      if (current === 0) {
        const iv = Buffer.alloc(16);
        iv.writeUInt32BE(37, 12);
        routes.set(`/aes/${localUri}`, encrypt(body, key1, iv));
        declaration = '#EXT-X-KEY:METHOD=AES-128,URI="key1"';
      }
      else if (current === 1) {
        routes.set(`/aes/${localUri}`, encrypt(body, key2, explicitIv));
        declaration = `#EXT-X-KEY:METHOD=AES-128,URI="key2",IV=0x${explicitIv.toString('hex')}`;
      }
      else {
        routes.set(`/aes/${localUri}`, body);
        declaration = '#EXT-X-KEY:METHOD=NONE';
      }
      return `${declaration}\n${localUri}`;
    });
  routes.set('/aes/media.m3u8', contents);
  const prepared = await prepare(`${origin}/aes/media.m3u8`);
  try {
    const local = fs.readFileSync(prepared.inputs[0].input, 'utf8');
    assert.match(local, /#EXT-X-MEDIA-SEQUENCE:37/);
    assert.match(local, /#EXT-X-KEY:METHOD=NONE/);
    assertDecodedMatch(probe(prepared, 'aes-remux'));
  }
  finally { prepared.cleanup(); }
});

test('AES-128 encrypted fMP4 maps retain their declaration-time key', async () => {
  const key = randomBytes(16);
  const iv = Buffer.alloc(16, 9);
  routes.set('/aes-map/key', key);
  routes.set('/aes-map/init.mp4', encrypt(routes.get('/fmp4/init.mp4'), key, iv));
  let contents = fmp4.contents.replace('#EXT-X-MAP:', `#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${iv.toString('hex')}\n#EXT-X-MAP:`);
  contents = contents.replace(/^media\d+\.m4s$/gm, (uri) => {
    routes.set(`/aes-map/${uri}`, routes.get(`/fmp4/${uri}`));
    return `#EXT-X-KEY:METHOD=NONE\n${uri}`;
  });
  routes.set('/aes-map/media.m3u8', contents);
  const prepared = await prepare(`${origin}/aes-map/media.m3u8`);
  try { probe(prepared, 'aes-map-remux'); }
  finally { prepared.cleanup(); }
});

test('unsupported encryption and malformed keys retain the FFmpeg fallback', async () => {
  for (const declaration of [
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMAT="example.drm"'
  ]) {
    assert.throws(() => planHLSPlaylist(ts.contents.replace('#EXTINF:', `${declaration}\n#EXTINF:`), ts.src), /unsupported HLS/);
  }
  const contents = ts.contents.replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="short-key"\n#EXTINF:');
  routes.set('/ts/short-key', Buffer.alloc(8));
  routes.set('/ts/short-key.m3u8', contents);
  const src = `${origin}/ts/short-key.m3u8`;
  const instance = task(src);
  const params = { inputs: [{ input: src, parallelSegmentDownloadSrc: src }], output: 'unused' };
  assert.equal(await instance.prepare(params, { tmpFilePath: path.join(root, 'key-fail.tmp.mp4') }), params);
  assert.equal(fs.readdirSync(root).some((file) => file.startsWith('key-fail.tmp.mp4.hls-')), false);
});

test('master playlists download the default external audio with a shared worker limit', async () => {
  const src = `${origin}/master.m3u8`;
  routes.set('/master.m3u8', [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="other",DEFAULT=NO,AUTOSELECT=YES,URI="missing-audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="chosen",DEFAULT=YES,AUTOSELECT=YES,URI="audio-only/media.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,AUDIO="sound"',
    'video-only/media.m3u8', ''
  ].join('\n'));
  const instance = task(src, { maxVideoResolution: 100 });
  const params = await instance.select();
  assert.equal(params.inputs[0].parallelAudioDownloadSrc, audioOnly.src);
  peak = 0;
  const prepared = await instance.prepare(params, { tmpFilePath: path.join(root, 'audio.tmp.mp4') });
  assert.equal(prepared.noProxy, true);
  try {
    assert.ok(peak <= 2);
    assert.match(fs.readFileSync(prepared.inputs[0].input, 'utf8'), /#EXT-X-MEDIA:TYPE=AUDIO/);
    probe(prepared, 'external-audio-remux');
    assert.equal(requests.some((r) => r.url === '/missing-audio.m3u8'), false);
  }
  finally { prepared.cleanup(); }
});

test('variants without AAC metadata are eligible and missing audio groups explain fallback', async () => {
  routes.set('/no-aac.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42e01e"\nvideo-only/media.m3u8\n');
  assert.equal((await task(`${origin}/no-aac.m3u8`).select()).inputs[0].parallelSegmentDownloadSrc, videoOnly.src);
  routes.set('/missing-group.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="missing"\nvideo-only/media.m3u8\n');
  const instance = task(`${origin}/missing-group.m3u8`);
  const params = await instance.select();
  assert.equal(await instance.prepare(params, { tmpFilePath: 'unused' }), params);
  assert.ok(instance.logs.some((e) => e.level === 'info' && e.message.join(' ').includes('missing audio group')));
});

test('non-AAC muxed audio passes through the concurrent flow', async () => {
  routes.set('/ac3-master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42e01e,ac-3"\nac3/media.m3u8\n');
  const instance = task(`${origin}/ac3-master.m3u8`);
  const prepared = await instance.prepare(await instance.select(), { tmpFilePath: path.join(root, 'ac3.tmp.mp4') });
  assert.equal(prepared.noProxy, true);
  try { probe(prepared, 'ac3-remux'); }
  finally { prepared.cleanup(); }
});

test('master and media redirects resolve relative resources against the final URL', async () => {
  routes.set('/redirect-master.m3u8', { location: '/nested/master.m3u8' });
  routes.set('/nested/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n../ts/media.m3u8\n');
  const params = await task(`${origin}/redirect-master.m3u8`).select();
  assert.equal(params.inputs[0].parallelSegmentDownloadSrc, ts.src);
  routes.set('/redirect-media.m3u8', { location: '/fmp4/media.m3u8' });
  const prepared = await prepare(`${origin}/redirect-media.m3u8`);
  try { probe(prepared, 'redirect-remux'); }
  finally { prepared.cleanup(); }
});

test('external audio fallback retains the selected video resolution and audio input', async () => {
  routes.set('/fallback-master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio",DEFAULT=YES,URI="audio-only/live.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,AUDIO="a"\nvideo-only/media.m3u8\n');
  routes.set('/audio-only/live.m3u8', audioOnly.contents.replace('#EXT-X-ENDLIST', ''));
  const instance = task(`${origin}/fallback-master.m3u8`, { maxVideoResolution: 100 });
  const params = await instance.select();
  const prepared = await instance.prepare(params, { tmpFilePath: path.join(root, 'fallback.tmp.mp4') });
  assert.equal(prepared, params);
  assert.equal(prepared.inputs[0].input, videoOnly.src);
  assert.equal(prepared.inputs[1].input, `${origin}/audio-only/live.m3u8`);
  assert.deepEqual(prepared.outputOptions, ['-map 0:v:0', '-map 1:a:0']);
});

test('task cancellation waits for download workers and removes temporary inputs', { timeout: 5000 }, async () => {
  let trigger;
  const requested = new Promise((resolve) => { trigger = resolve; });
  const listener = (req) => { if (req.url.startsWith('/cancel/segment')) trigger(); };
  server.on('request', listener);
  const contents = ts.contents.replace(/^media\d+\.ts$/gm, (uri) => {
    routes.set(`/cancel/segment-${uri}`, { body: routes.get(`/ts/${uri}`), delay: 200 });
    return `segment-${uri}`;
  });
  routes.set('/cancel/media.m3u8', contents);
  const instance = task(`${origin}/cancel/media.m3u8`);
  try {
    const started = instance.start();
    await requested;
    assert.equal(instance.status, 'downloading');
    await instance.abort();
    await started;
    assert.equal(instance.status, 'aborted');
    assert.equal(fs.readdirSync(root).some((file) => file.includes('.hls-')), false);
  }
  finally { server.off('request', listener); }
});

test('short hexadecimal AES IVs are padded without changing quoted key URIs', async () => {
  const key = randomBytes(16);
  const iv = Buffer.alloc(16);
  iv[15] = 1;
  routes.set('/short-iv/key?value=IV=0x2', key);
  const contents = ts.contents.replace(/^media\d+\.ts$/gm, (uri) => {
    routes.set(`/short-iv/${uri}`, encrypt(routes.get(`/ts/${uri}`), key, iv));
    return uri;
  }).replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="key?value=IV=0x2",IV=0x1\n#EXTINF:');
  routes.set('/short-iv/media.m3u8', contents);
  const src = `${origin}/short-iv/media.m3u8`;
  const instance = task(src);
  const prepared = await instance.prepare(await instance.select(), { tmpFilePath: path.join(root, 'short-iv.tmp.mp4') });
  assert.equal(prepared.noProxy, true);
  try {
    assert.match(fs.readFileSync(prepared.inputs[0].input, 'utf8'), /IV=0x00000000000000000000000000000001/);
    assertDecodedMatch(probe(prepared, 'short-iv-remux'));
  }
  finally { prepared.cleanup(); }
});

test('full task completes once and cleans localized inputs after FFmpeg remux', { timeout: 10000 }, async () => {
  const instance = task(fmp4.src);
  await instance.start();
  assert.equal(instance.status, 'completed', instance.logs.map((e) => e.message.join(' ')).join('\n'));
  assert.ok(instance.srcEntity.downloaded.path.endsWith('.mp4'));
  assert.ok(instance.commandLine.includes('media.m3u8'));
  assert.equal(fs.readdirSync(root).some((file) => file.includes('.hls-')), false);
});
