import m3u8Parser, { type Manifest, type Segment } from 'm3u8-parser';

export interface HLSResource {
  index: number;
  url: string;
  filename: string;
  byteRange?: { offset: number; length: number };
  expectedSize?: number;
}

export interface HLSPlaylistPlan {
  contents: string;
  resources: HLSResource[];
}

export function parseHLSPlaylist(contents: string) {
  const parser = new m3u8Parser.Parser();
  parser.push(normalizeKeyIVs(contents));
  parser.end();
  return parser.manifest;
}

export function planHLSPlaylist(contents: string, source: string, prefix = ''): HLSPlaylistPlan {
  assertSupportedKeys(normalizeKeyIVs(contents));
  const manifest = parseHLSPlaylist(contents);
  assertStaticPlaylist(manifest, contents);
  assertImplicitByteRanges(manifest, contents, source);
  const resources: HLSResource[] = [];
  const maps = new Map<string, string>();
  const keys = new Map<NonNullable<Segment['key']>, string>();
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${Math.max(7, manifest.version || 1)}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(manifest.targetDuration || Math.max(...manifest.segments.map((s) => s.duration)))}`,
    `#EXT-X-MEDIA-SEQUENCE:${manifest.mediaSequence || 0}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${manifest.discontinuitySequence || 0}`
  ];
  if (manifest.start) {
    lines.push(`#EXT-X-START:TIME-OFFSET=${Number(manifest.start.timeOffset)},PRECISE=${manifest.start.precise ? 'YES' : 'NO'}`);
  }
  const addResource = (uri: string, extension: string, byteRange?: HLSResource['byteRange'], expectedSize?: number) => {
    const url = new URL(uri, source);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`resource uses unsupported protocol "${url.protocol}"`);
    }
    const index = resources.length;
    const filename = `${prefix}resource-${String(index).padStart(6, '0')}.${extension}`;
    if (byteRange && (!Number.isSafeInteger(byteRange.offset) || byteRange.offset < 0 ||
      !Number.isSafeInteger(byteRange.length) || byteRange.length <= 0 || !Number.isSafeInteger(byteRange.offset + byteRange.length))) {
      throw new Error('playlist has an invalid or unresolved byte range');
    }
    resources.push({ index, url: url.href, filename, byteRange, expectedSize });
    return filename;
  };
  let activeKey = '#EXT-X-KEY:METHOD=NONE';
  const setKey = (key: Segment['key']) => {
    let declaration = '#EXT-X-KEY:METHOD=NONE';
    if (key) {
      if (key.method !== 'AES-128') throw new Error(`unsupported HLS encryption method "${key.method}"`);
      let filename = keys.get(key);
      if (!filename) {
        filename = addResource(key.uri, 'key', undefined, 16);
        keys.set(key, filename);
      }
      declaration = `#EXT-X-KEY:METHOD=AES-128,URI="${filename}"`;
      if (key.iv) {
        declaration += `,IV=0x${Array.from(key.iv, (word) => word.toString(16).padStart(8, '0')).join('')}`;
      }
    }
    if (declaration !== activeKey) {
      lines.push(declaration);
      activeKey = declaration;
    }
  };
  for (const segment of manifest.segments) {
    if (!Number.isFinite(segment.duration) || segment.duration <= 0 || !segment.uri) {
      throw new Error('playlist has an invalid media segment');
    }
    if (segment.discontinuity) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    if (segment.dateTimeString) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.dateTimeString}`);
    }
    if (segment.map) {
      // The parser includes the key active when the map was declared, independently of the segment key.
      const mapKey = (segment.map as typeof segment.map & { key?: Segment['key'] }).key;
      if (mapKey && !mapKey.iv) throw new Error('encrypted initialization map has no explicit IV');
      setKey(mapKey);
      const identity = JSON.stringify([new URL(segment.map.uri, source).href, segment.map.byterange, activeKey]);
      let filename = maps.get(identity);
      if (!filename) {
        filename = addResource(segment.map.uri, 'mp4', segment.map.byterange);
        maps.set(identity, filename);
      }
      lines.push(`#EXT-X-MAP:URI="${filename}"`);
    }
    setKey(segment.key);
    lines.push(`#EXTINF:${segment.duration},`, addResource(segment.uri, segment.map ? 'm4s' : 'ts', segment.byterange));
  }
  lines.push('#EXT-X-ENDLIST', '');
  return { contents: lines.join('\n'), resources };
}

function assertSupportedKeys(contents: string) {
  // Runtime ParseStream events are public; the upstream typings mark Stream.on as private.
  const stream = new m3u8Parser.ParseStream() as unknown as {
    on(type: 'data', listener: (entry: { tagType?: string; attributes?: {
      METHOD?: string; URI?: string; KEYFORMAT?: string;
    } }) => void): void;
    push(line: string): void;
  };
  stream.on('data', ({ tagType, attributes }) => {
    if (tagType !== 'key') return;
    if (attributes?.METHOD === 'NONE') return;
    if (attributes?.METHOD !== 'AES-128') throw new Error(`unsupported HLS encryption method "${String(attributes?.METHOD)}"`);
    if (attributes.KEYFORMAT && attributes.KEYFORMAT !== 'identity') {
      throw new Error(`unsupported HLS key format "${attributes.KEYFORMAT}" (DRM or non-identity encryption)`);
    }
    if (!attributes.URI) throw new Error('encryption key has no URI');
  });
  for (const line of contents.split('\n')) stream.push(line.trim());
}

function normalizeKeyIVs(contents: string) {
  // Skip quoted attribute values so a token inside a key URI is never rewritten.
  return contents.split('\n').map((line) => {
    if (!line.trim().startsWith('#EXT-X-KEY:')) return line;
    return line.replace(/"[^"]*"|\bIV=([^,\s]+)/g, (match: string, iv: string | undefined) => {
      if (iv === undefined) return match;
      if (!/^0x[\da-f]{1,32}$/i.test(iv)) throw new Error('encryption key has an invalid 128-bit IV');
      // m3u8-parser expects four full 32-bit words, while HLS also permits shorter hex integers.
      return `IV=0x${iv.slice(2).padStart(32, '0')}`;
    });
  }).join('\n');
}

function assertStaticPlaylist(manifest: Manifest, contents: string) {
  if (manifest.playlists?.length) {
    throw new Error('playlist is a master playlist instead of a media playlist');
  }
  if (manifest.endList !== true) {
    throw new Error('playlist is not static (missing EXT-X-ENDLIST)');
  }
  if (!manifest.segments?.length) {
    throw new Error('playlist has no media segments');
  }
  if (manifest.contentProtection && Object.keys(manifest.contentProtection).length) {
    throw new Error('playlist has DRM content protection');
  }
  if (manifest.preloadSegment || manifest.skip || manifest.serverControl || manifest.partInf ||
    manifest.renditionReports?.length || manifest.segments.some((s) => s.parts?.length || s.preloadHints?.length)) {
    throw new Error('playlist uses live or low-latency HLS features');
  }
  if (/^#EXT-X-(?:DEFINE|GAP|I-FRAMES-ONLY)(?::|\s|$)/m.test(contents)) {
    throw new Error('playlist uses variable substitution, gaps, or I-frame-only segments');
  }
}

function assertImplicitByteRanges(manifest: Manifest, contents: string, source: string) {
  let index = 0;
  let implicitRange = false;
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      implicitRange = !line.includes('@');
    }
    if (!line || line.startsWith('#')) continue;
    if (implicitRange) {
      const segment = manifest.segments[index];
      const previous = manifest.segments[index - 1];
      if (!previous?.byterange || !segment || new URL(previous.uri, source).href !== new URL(segment.uri, source).href) {
        throw new Error('implicit byte range does not follow a range of the same resource');
      }
    }
    implicitRange = false;
    index++;
  }
}
