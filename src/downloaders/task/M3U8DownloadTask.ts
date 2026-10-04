import { type VideoMediaItem } from '../../entities/MediaItem.js';
import { SITE_URL } from '../../utils/URLHelper.js';
import FFmpegDownloadTaskBase, {
  type FFmpegCommandParams,
  type FFmpegCommandPrepareContext,
  type FFmpegDownloadTaskBaseParams,
  type PreparedFFmpegCommandParams
} from './FFmpegDownloadTaskBase.js';
import semver from 'semver';
import m3u8Parser, { type Manifest, type PlaylistItem, type Segment } from 'm3u8-parser';
import type Fetcher from '../../utils/Fetcher.js';
import FSHelper from '../../utils/FSHelper.js';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';

const MAX_PARALLEL_SEGMENT_DOWNLOADS = 10;

interface Variant extends PlaylistItem {
  protected?: boolean;
}

interface ParallelMpegTsSegment {
  index: number;
  url: string;
}

interface DownloadedSegment {
  filePath: string;
  size: number;
}

type PickVariantResult = {
  src: null;
  reason: string;
} | {
  src: string;
  resolution: string | null,
  protected?: boolean;
  parallelSegmentDownloadSrc?: string | null;
};

export interface M3U8DownloadTaskParams extends FFmpegDownloadTaskBaseParams<VideoMediaItem> {
  fetcher: Fetcher;
  destFilePath: string;
}

interface M3U8FFmpegCommandParams extends FFmpegCommandParams {
  inputs: (FFmpegCommandParams['inputs'][number] & {
    resolution: string | null;
    parallelSegmentDownloadSrc?: string | null;
  })[];
};

export default class M3U8DownloadTask extends FFmpegDownloadTaskBase<VideoMediaItem> {

  name = 'M3U8DownloadTask';

  #skipOnStart: {
    reason: string;
  } | null;
  #fetcher: Fetcher;
  #unresolvedDestFilePath: string;
  #ffmpegCommandParams: M3U8FFmpegCommandParams | null;

  constructor(params: M3U8DownloadTaskParams) {
    super(params);
    this.#fetcher = params.fetcher;
    this.#unresolvedDestFilePath = params.destFilePath;
    this.#ffmpegCommandParams = null;
    this.#skipOnStart = null;
  }

  async start() {
    if (this.#skipOnStart) {
      return this.notifySkip({
        name: 'other',
        message: this.#skipOnStart.reason,
      });
    }
    return await super.start();
  }

  protected async resolveDestPath(signal?: AbortSignal) {
    const params = await this.getFFmpegCommandParams(signal);
    return params.output;
  }

  protected async getFFmpegCommandParams(signal?: AbortSignal): Promise<M3U8FFmpegCommandParams> {
    if (this.#ffmpegCommandParams) {
      return this.#ffmpegCommandParams;
    }

    const input = await this.#pickVariant(signal);
    if (input.src === null) {
      this.#skipOnStart = {
        reason: `No downloadable source - ${input.reason}`
      };
    }

    const inputOptions = [
      '-http_multiple',
      '1',
      '-protocol_whitelist',
      'http,https,tcp,tls',
      '-headers',
      `Referer: ${SITE_URL}`
    ];
    // `extension_picky` introduced in v7.1.1
    if (semver.satisfies(this.getFFmpegVersion(), '>=7.1.1')) {
      inputOptions.push('-extension_picky', '0');
    }
    let output = this.#unresolvedDestFilePath;
    if (input.src) {
      if (input.protected || input.resolution) {
        const parsedFilePath = path.parse(this.#unresolvedDestFilePath);
        const { ext, dir } = parsedFilePath;
        let filename = parsedFilePath.name;
        if (input.resolution) {
          filename += ` (${input.resolution})`;
        }
        if (input.protected) {
          filename += ' drm';
        }
        output = path.resolve(dir, FSHelper.sanitizeFilename(`${filename}${ext}`));
      }

      const criteria = JSON.stringify({
        'max video resolution': this.config.maxVideoResolution || undefined,
        'include protected media':  this.config.include.protectedMedia ? 'yes' : undefined
      });
      const criteriaStr  = criteria === '{}' ? '' : ` matching criteria ${JSON.stringify(criteria)}`;
      const streamInfoParts = [
        input.resolution || 'unknown resolution',
        input.protected === true ? 'protected'
          : input.protected === false ? ''
          : 'unknown'
      ];
      this.log('info', `Target stream${criteriaStr}:`, streamInfoParts.join(';'));
    }

    this.#ffmpegCommandParams = {
      inputs: [
        {
          input: input.src || this.src,
          options: inputOptions,
          resolution: input.src ? input.resolution : null,
          parallelSegmentDownloadSrc: input.src ? input.parallelSegmentDownloadSrc : null
        }
      ],
      output
    };

    return this.#ffmpegCommandParams;
  }

  protected getTargetDuration(): number | null {
    return this.srcEntity.duration;
  }

  protected override async prepareFFmpegCommandParams(
    params: FFmpegCommandParams,
    context: FFmpegCommandPrepareContext
  ): Promise<PreparedFFmpegCommandParams> {
    const m3u8Params = params as M3U8FFmpegCommandParams;
    const input = m3u8Params.inputs[0];
    const playlistSrc = input?.parallelSegmentDownloadSrc || null;

    if (!playlistSrc) {
      this.log('debug', 'Parallel HLS segment download not attempted for this stream');
      return params;
    }
    if (this.dryRun) {
      this.log('debug', 'Parallel HLS segment download skipped during dry-run');
      return params;
    }
    if (!this.#isHTTPURL(playlistSrc)) {
      this.log('debug', `Parallel HLS segment download skipped for non-HTTP playlist "${playlistSrc}"`);
      return params;
    }

    const prepared = await this.#prepareParallelMpegTsInput(playlistSrc, context.tmpFilePath, context.signal);
    if (!prepared) {
      return params;
    }

    return {
      ...params,
      inputs: [
        {
          input: prepared.input,
          options: [
            '-f',
            'mpegts'
          ]
        }
      ],
      noProxy: true,
      cleanup: prepared.cleanup
    };
  }

  async #prepareParallelMpegTsInput(playlistSrc: string, ffmpegTmpFilePath: string, signal?: AbortSignal) {
    let segmentDir: string | null = null;
    let mpegTsInputPath: string | null = null;
    const downloadedSegments: DownloadedSegment[] = [];

    try {
      const playlist = await this.#getParallelMpegTsPlaylist(playlistSrc, signal);
      if (!playlist.ok) {
        this.log('debug', `Parallel HLS segment download skipped: ${playlist.reason}`);
        return null;
      }

      const segments = playlist.segments;
      const concurrency = Math.min(
        segments.length,
        MAX_PARALLEL_SEGMENT_DOWNLOADS,
        Math.max(1, this.config.request.maxConcurrent)
      );

      mpegTsInputPath = this.#createParallelMpegTsInputPath(ffmpegTmpFilePath);
      segmentDir = `${mpegTsInputPath}.segments`;
      this.fsHelper.createDir(segmentDir);

      this.log('info', `Download ${segments.length} HLS MPEG-TS segments with up to ${concurrency} concurrent requests`);
      await this.#downloadParallelSegments(segments, segmentDir, concurrency, signal, downloadedSegments);
      await this.#concatSegments(downloadedSegments, mpegTsInputPath, signal);

      const size = fs.lstatSync(mpegTsInputPath).size;
      this.log('debug', `Prepared parallel HLS MPEG-TS input "${mpegTsInputPath}"; filesize: ${size} bytes`);
      this.#cleanupSegmentFiles(downloadedSegments, segmentDir);
      segmentDir = null;

      return {
        input: mpegTsInputPath,
        cleanup: () => this.#unlinkIfExists(mpegTsInputPath as string)
      };
    }
    catch (error) {
      this.#cleanupSegmentFiles(downloadedSegments, segmentDir);
      if (mpegTsInputPath) {
        this.#unlinkIfExists(mpegTsInputPath);
      }
      if (signal?.aborted) {
        throw error;
      }
      this.log('warn', 'Parallel HLS segment download failed; falling back to FFmpeg HLS input:', error);
      return null;
    }
  }

  async #getParallelMpegTsPlaylist(playlistSrc: string, signal?: AbortSignal): Promise<{
    ok: true;
    segments: ParallelMpegTsSegment[];
  } | {
    ok: false;
    reason: string;
  }> {
    const { contents: m3u8, lastUrl } = await this.#fetcher.get({
      url: playlistSrc,
      type: 'm3u8',
      maxRetries: this.config.request.maxRetries,
      signal
    });
    const manifest = this.#parseM3U8(m3u8);
    return this.#getPlainMpegTsSegments(manifest, lastUrl || playlistSrc);
  }

  #getPlainMpegTsSegments(manifest: Manifest, playlistSrc: string): {
    ok: true;
    segments: ParallelMpegTsSegment[];
  } | {
    ok: false;
    reason: string;
  } {
    if (manifest.playlists && manifest.playlists.length > 0) {
      return { ok: false, reason: 'playlist is a master playlist' };
    }
    if (manifest.endList !== true) {
      return { ok: false, reason: 'playlist is not static (missing EXT-X-ENDLIST)' };
    }
    if (!manifest.segments || manifest.segments.length === 0) {
      return { ok: false, reason: 'playlist has no media segments' };
    }
    if (manifest.contentProtection && Object.keys(manifest.contentProtection).length > 0) {
      return { ok: false, reason: 'playlist has content protection' };
    }
    if (manifest.discontinuityStarts && manifest.discontinuityStarts.length > 0) {
      return { ok: false, reason: 'playlist has discontinuities' };
    }
    if (manifest.preloadSegment || manifest.skip || manifest.serverControl ||
      manifest.partInf || (manifest.renditionReports && manifest.renditionReports.length > 0)) {
      return { ok: false, reason: 'playlist uses live or low-latency HLS features' };
    }

    const firstTimeline = manifest.segments[0]?.timeline ?? 0;
    const segments: ParallelMpegTsSegment[] = [];

    for (let index = 0; index < manifest.segments.length; index++) {
      const segment = manifest.segments[index];
      const unsupportedReason = this.#getUnsupportedSegmentReason(segment, firstTimeline, playlistSrc);
      if (unsupportedReason) {
        return { ok: false, reason: unsupportedReason };
      }
      segments.push({
        index,
        url: new URL(segment.uri, playlistSrc).href
      });
    }

    return {
      ok: true,
      segments
    };
  }

  #getUnsupportedSegmentReason(segment: Segment, firstTimeline: number, playlistSrc: string) {
    if (segment.key) {
      return 'playlist has encrypted segments';
    }
    if (segment.byterange) {
      return 'playlist uses byte-range segments';
    }
    if (segment.map) {
      return 'playlist uses fMP4 init maps';
    }
    if (segment.discontinuity || (segment.timeline ?? firstTimeline) !== firstTimeline) {
      return 'playlist has discontinuities';
    }
    if ((segment.parts && segment.parts.length > 0) ||
      (segment.preloadHints && segment.preloadHints.length > 0)) {
      return 'playlist uses low-latency HLS segment parts';
    }
    if (!this.#isLikelyMpegTsSegment(segment.uri, playlistSrc)) {
      return `segment "${segment.uri}" is not a plain MPEG-TS segment`;
    }
    return null;
  }

  async #downloadParallelSegments(
    segments: ParallelMpegTsSegment[],
    segmentDir: string,
    concurrency: number,
    signal: AbortSignal | undefined,
    downloadedSegments: DownloadedSegment[]
  ) {
    let nextIndex = 0;
    let completeCount = 0;
    let downloadedSize = 0;

    const worker = async () => {
      while (true) {
        if (signal?.aborted) {
          throw new Error('Parallel HLS segment download aborted');
        }

        const currentIndex = nextIndex++;
        if (currentIndex >= segments.length) {
          return;
        }

        const segment = segments[currentIndex];
        const segmentFilePath = path.resolve(
          segmentDir,
          FSHelper.createFilename({
            name: String(segment.index).padStart(6, '0'),
            ext: '.ts'
          })
        );
        const size = await this.#downloadSegmentWithRetries(segment, segmentFilePath, signal);
        downloadedSegments[segment.index] = {
          filePath: segmentFilePath,
          size
        };

        completeCount++;
        downloadedSize += size;
        if (completeCount === segments.length || completeCount % 25 === 0) {
          this.log('debug', `Downloaded ${completeCount}/${segments.length} HLS segments (${Math.round(downloadedSize / 1024)} KiB)`);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  async #downloadSegmentWithRetries(segment: ParallelMpegTsSegment, filePath: string, signal?: AbortSignal) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.request.maxRetries; attempt++) {
      try {
        return await this.#downloadSegmentToFile(segment.url, filePath, signal);
      }
      catch (error) {
        this.#unlinkIfExists(filePath);
        if (signal?.aborted) {
          throw error;
        }
        lastError = error;
        if (attempt < this.config.request.maxRetries) {
          this.log('debug', `Retry HLS segment ${segment.index + 1} (${attempt + 1}/${this.config.request.maxRetries})`);
        }
      }
    }

    throw lastError;
  }

  async #downloadSegmentToFile(url: string, filePath: string, signal?: AbortSignal) {
    const internalAbortController = signal ? null : new AbortController();
    const segmentSignal = signal || internalAbortController?.signal as AbortSignal;
    const tmpFilePath = `${filePath}.part`;
    this.#unlinkIfExists(filePath);
    this.#unlinkIfExists(tmpFilePath);

    try {
      const download = await this.#fetcher.prepareDownload({
        url,
        srcEntity: this.srcEntity,
        destFilePath: filePath,
        setReferer: true,
        signal: segmentSignal
      });
      const result = await download.start({
        destFilePath: filePath,
        tmpFilePath
      });
      result.commit();
      return fs.lstatSync(filePath).size;
    }
    catch (error) {
      this.#unlinkIfExists(tmpFilePath);
      this.#unlinkIfExists(filePath);
      throw error;
    }
  }

  async #concatSegments(downloadedSegments: DownloadedSegment[], outputPath: string, signal?: AbortSignal) {
    this.#unlinkIfExists(outputPath);
    const output = fs.createWriteStream(outputPath);

    try {
      for (const segment of downloadedSegments) {
        if (signal?.aborted) {
          throw new Error('Parallel HLS segment download aborted');
        }
        if (!segment) {
          throw new Error('Missing downloaded HLS segment');
        }
        await pipeline(fs.createReadStream(segment.filePath), output, { end: false });
      }
    }
    catch (error) {
      output.destroy();
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      output.once('error', reject);
      output.end(() => resolve());
    });
  }

  #cleanupSegmentFiles(downloadedSegments: DownloadedSegment[], segmentDir: string | null) {
    for (const segment of downloadedSegments) {
      if (segment) {
        this.#unlinkIfExists(segment.filePath);
      }
    }
    if (segmentDir && fs.existsSync(segmentDir)) {
      try {
        fs.rmdirSync(segmentDir);
      }
      catch (_error) {
        // Best effort only; stale segment files are safer than recursive deletion.
      }
    }
  }

  #createParallelMpegTsInputPath(ffmpegTmpFilePath: string) {
    const { dir, name } = path.parse(ffmpegTmpFilePath);
    return path.resolve(
      dir,
      FSHelper.createFilename({
        name: `${name}.hls-segments`,
        ext: '.ts'
      })
    );
  }

  #unlinkIfExists(filePath: string) {
    if (this.dryRun || fs.existsSync(filePath)) {
      this.fsHelper.unlink(filePath);
    }
  }

  #isHTTPURL(src: string) {
    try {
      const url = new URL(src);
      return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch (_error) {
      return false;
    }
  }

  #isLikelyMpegTsSegment(uri: string, playlistSrc: string) {
    try {
      const url = new URL(uri, playlistSrc);
      const pathname = url.pathname.toLowerCase();
      return pathname.endsWith('.ts') || pathname.endsWith('.mpegts');
    }
    catch (_error) {
      return false;
    }
  }

  async #pickVariant(signal?: AbortSignal): Promise<PickVariantResult> {
    const { contents: m3u8 } = await this.#fetcher.get({
      url: this.src,
      type: 'm3u8',
      maxRetries: this.config.request.maxRetries,
      signal
    });
    const manifest = this.#parseM3U8(m3u8);

    if (!manifest.playlists || manifest.playlists.length === 0) {
      this.log('warn', `No stream found in m3u8 manifest - going to download without stream selection`);
      return {
        src: this.src,
        resolution: 'best quality',
        protected: undefined,
        parallelSegmentDownloadSrc: this.src
      };
    }

    const orderedPlaylistItems = manifest.playlists
      .sort((a, b) => {
        // 1. Get heights or 0
        const heightA = a.attributes.RESOLUTION?.height || 0;
        const heightB = b.attributes.RESOLUTION?.height || 0;

        // 2. If heights are different, sort by height
        if (heightB !== heightA) {
          return heightB - heightA;
        }

        // 3. If heights are the same (or both 0), sort by BANDWIDTH
        const bandwidthA = a.attributes.BANDWIDTH || 0;
        const bandwidthB = b.attributes.BANDWIDTH || 0;

        return bandwidthB - bandwidthA;
      });
    let variants = await this.#getProtectionStatus(orderedPlaylistItems, signal);
    
    if (variants.every((v) => v.protected === false) && !this.config.maxVideoResolution) {
      const selected = variants[0];
      return {
        src: this.src,
        resolution: 'best quality',
        protected: false,
        parallelSegmentDownloadSrc: selected ? this.#getParallelSegmentDownloadSrcForVariant(selected, manifest) : null
      };
    }

    this.log('debug', `m3u8 has ${variants?.length ?? 0} variants (src: ${this.src})`);
  
    // include.protectedMedia
    if (!this.config.include.protectedMedia) {
      const prevLength = variants.length;
      variants = variants.filter((v) => !v.protected)
      if (variants.length === 0) {
        this.log('debug', 'All streams are protected');
        return {
          src: null,
          reason: 'Media is protected'
        };
      }
      else {
        this.log('debug', `${(prevLength - variants.length) / prevLength} streams are protected`)
      }
    }

    // maxVideoResolution
    const maxResolution = this.config.maxVideoResolution;
    const hasMaxResolutionConfigured = maxResolution && maxResolution > 0;
   
    const __hasAudio = (variant: typeof variants[number]) => {
      const codecs = variant.attributes.CODECS || "";
      return codecs.includes("mp4a"); // crude check for AAC audio
    }

    const allWithoutAudio = variants.every((v) => !__hasAudio(v));

    if (hasMaxResolutionConfigured) {
      this.log('debug', `Apply maxVideoResolution "${maxResolution}"`);
      const maxResCandidates = variants
        .filter((v) => (v.attributes.RESOLUTION && v.attributes.RESOLUTION.height <= maxResolution) && (allWithoutAudio || __hasAudio(v)));
      if (maxResCandidates.length === 0 ) {
        this.log('debug', `No stream in m3u8 manifest has resolution "${maxResolution}" or lower - maxVideoResolution not applied`);
      }
      else {
        variants = maxResCandidates;
      }
    }

    const selected = variants[0];

    return {
      src: new URL(selected.uri, this.src).href,
      resolution: this.#getResolutionString(selected),
      protected: selected.protected,
      parallelSegmentDownloadSrc: this.#getParallelSegmentDownloadSrcForVariant(selected, manifest)
    };
  }

  async #getProtectionStatus(variants: PlaylistItem[], signal?: AbortSignal): Promise<Variant[]> {
    return await Promise.all(variants.map((variant) =>
      this.#fetcher.get({
        url: new URL(variant.uri, this.src).href,
        type: 'm3u8',
        maxRetries: this.config.request.maxRetries,
        signal
      })
      .then(({contents: m3u8}) => {
        const manifest = this.#parseM3U8(m3u8);
        const protectionData = manifest.contentProtection;
        const _protected = !!(protectionData && typeof protectionData === 'object' && Object.entries(protectionData).length > 0);
        return {
          ...variant,
          protected: _protected
        };
      })
      .catch((error: unknown) => {
        if (signal?.aborted) {
          throw error;
        }
        this.log('warn', `Could not determine if stream (${this.#getResolutionString(variant)}) is protected:`, error);
        return {
          ...variant,
          protected: undefined
        };
      })
    ));
  }

  #parseM3U8(m3u8: string) {
    const parser = new m3u8Parser.Parser();
    parser.push(m3u8);
    parser.end();
    return parser.manifest;
  }

  #getParallelSegmentDownloadSrcForVariant(variant: PlaylistItem, manifest: Manifest) {
    if (!this.#variantCanUseParallelSegmentDownload(variant, manifest)) {
      return null;
    }
    return new URL(variant.uri, this.src).href;
  }

  #variantCanUseParallelSegmentDownload(variant: PlaylistItem, manifest: Manifest) {
    const codecs = variant.attributes.CODECS?.toLowerCase();
    if (variant.attributes.AUDIO) {
      return false;
    }
    if (codecs && !codecs.includes('mp4a')) {
      return false;
    }
    if (!codecs && manifest.mediaGroups?.AUDIO && Object.keys(manifest.mediaGroups.AUDIO).length > 0) {
      return false;
    }
    return true;
  }

  #getResolutionString(item: PlaylistItem) {
    if (item.attributes.RESOLUTION?.width && item.attributes.RESOLUTION?.height) {
      return `${item.attributes.RESOLUTION.width}x${item.attributes.RESOLUTION.height}`;
    }
    return null;
  }
}
