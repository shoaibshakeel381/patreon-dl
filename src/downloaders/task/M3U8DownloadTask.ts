import { type VideoMediaItem } from '../../entities/MediaItem.js';
import { SITE_URL } from '../../utils/URLHelper.js';
import FFmpegDownloadTaskBase, {
  type FFmpegCommandParams,
  type FFmpegCommandPrepareContext,
  type FFmpegDownloadTaskBaseParams,
  type PreparedFFmpegCommandParams
} from './FFmpegDownloadTaskBase.js';
import semver from 'semver';
import { type Manifest, type PlaylistItem } from 'm3u8-parser';
import { parseHLSPlaylist, planHLSPlaylist, type HLSResource } from './HLSPlaylist.js';
import type Fetcher from '../../utils/Fetcher.js';
import FSHelper from '../../utils/FSHelper.js';
import path from 'path';
import fs from 'fs';

const MAX_PARALLEL_SEGMENT_DOWNLOADS = 10;

interface Variant extends PlaylistItem {
  protected?: boolean;
}

type PickVariantResult = {
  src: null;
  reason: string;
} | {
  src: string;
  resolution: string | null,
  protected?: boolean;
  parallelSegmentDownloadSrc?: string | null;
  parallelSegmentDownloadSkipReason?: string;
  parallelAudioDownloadSrc?: string;
};

export interface M3U8DownloadTaskParams extends FFmpegDownloadTaskBaseParams<VideoMediaItem> {
  fetcher: Fetcher;
  destFilePath: string;
}

interface M3U8FFmpegCommandParams extends FFmpegCommandParams {
  inputs: (FFmpegCommandParams['inputs'][number] & {
    resolution: string | null;
    parallelSegmentDownloadSrc?: string | null;
    parallelSegmentDownloadSkipReason?: string;
    parallelAudioDownloadSrc?: string;
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
  #playlistBase: string;

  constructor(params: M3U8DownloadTaskParams) {
    super(params);
    this.#fetcher = params.fetcher;
    this.#unresolvedDestFilePath = params.destFilePath;
    this.#ffmpegCommandParams = null;
    this.#skipOnStart = null;
    this.#playlistBase = this.src;
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
          parallelSegmentDownloadSrc: input.src ? input.parallelSegmentDownloadSrc : null,
          parallelSegmentDownloadSkipReason: input.src === null ? input.reason : input.parallelSegmentDownloadSkipReason,
          parallelAudioDownloadSrc: input.src === null ? undefined : input.parallelAudioDownloadSrc
        }
      ],
      output
    };
    if (input.src !== null && input.parallelAudioDownloadSrc) {
      this.#ffmpegCommandParams.inputs[0].input = input.parallelSegmentDownloadSrc || input.src;
      this.#ffmpegCommandParams.inputs.push({ input: input.parallelAudioDownloadSrc, options: inputOptions, resolution: null });
      this.#ffmpegCommandParams.outputOptions = ['-map 0:v:0', '-map 1:a:0'];
    }

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
      this.log('info', `Parallel HLS segment download skipped: ${input?.parallelSegmentDownloadSkipReason || 'no eligible media playlist selected'}; using FFmpeg HLS input`);
      return params;
    }
    if (this.dryRun) {
      this.log('info', 'Parallel HLS segment download skipped: dry-run mode');
      return params;
    }
    if (!this.#isHTTPURL(playlistSrc)) {
      this.log('info', `Parallel HLS segment download skipped: non-HTTP playlist "${playlistSrc}"; using FFmpeg HLS input`);
      return params;
    }

    const prepared = await this.#prepareParallelHLSInput(playlistSrc, context.tmpFilePath, context.signal, input?.parallelAudioDownloadSrc);
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
            'hls',
            '-protocol_whitelist',
            'file,crypto',
            '-allowed_extensions',
            'ALL',
            ...(semver.satisfies(this.getFFmpegVersion(), '>=7.1.1') ? ['-extension_picky', '0'] : [])
          ]
        }
      ],
      noProxy: true,
      outputOptions: input?.parallelAudioDownloadSrc ? ['-map 0:v:0', '-map 0:a:0'] : params.outputOptions,
      cleanup: prepared.cleanup
    };
  }

  async #prepareParallelHLSInput(playlistSrc: string, ffmpegTmpFilePath: string, signal?: AbortSignal, audioSrc?: string) {
    let workDir: string | null = null;
    const files = new Set<string>();
    const cleanup = () => {
      for (const file of files) {
        if (fs.existsSync(file)) {
          this.fsHelper.unlink(file);
        }
      }
      if (workDir && fs.existsSync(workDir)) {
        fs.rmdirSync(workDir);
      }
    };
    try {
      const { contents, lastUrl } = await this.#fetcher.get({
        url: playlistSrc,
        type: 'm3u8',
        maxRetries: this.config.request.maxRetries,
        signal
      });
      let plan;
      let audioPlan;
      try {
        plan = planHLSPlaylist(contents, lastUrl || playlistSrc, 'video-');
        if (audioSrc) {
          const audio = await this.#fetcher.get({ url: audioSrc, type: 'm3u8', maxRetries: this.config.request.maxRetries, signal });
          audioPlan = planHLSPlaylist(audio.contents, audio.lastUrl || audioSrc, 'audio-');
        }
      }
      catch (error) {
        if (signal?.aborted) throw error;
        this.log('info', `Parallel HLS segment download skipped: ${error instanceof Error ? error.message : String(error)}; using FFmpeg HLS input`);
        return null;
      }
      signal?.throwIfAborted();
      const resources = [...plan.resources, ...(audioPlan?.resources || [])].map((resource, index) => ({ ...resource, index }));
      const concurrency = Math.min(resources.length, MAX_PARALLEL_SEGMENT_DOWNLOADS, Math.max(1, this.config.request.maxConcurrent));
      workDir = fs.mkdtempSync(`${ffmpegTmpFilePath}.hls-`);
      this.log('info', `Download ${resources.length} HLS resources with up to ${concurrency} concurrent requests${audioPlan ? ' (video and separate audio)' : ''}`);
      await this.#downloadParallelResources(resources, workDir, concurrency, files, signal);
      const input = path.resolve(workDir, 'media.m3u8');
      files.add(input);
      if (audioPlan) {
        for (const [filename, playlist] of [['video.m3u8', plan], ['audio.m3u8', audioPlan]] as const) {
          const file = path.resolve(workDir, filename);
          files.add(file);
          fs.writeFileSync(file, playlist.contents, 'utf8');
        }
        fs.writeFileSync(input, [
          '#EXTM3U', '#EXT-X-VERSION:7',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="selected",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="audio"', 'video.m3u8', ''
        ].join('\n'), 'utf8');
      }
      else fs.writeFileSync(input, plan.contents, 'utf8');
      return { input, cleanup };
    }
    catch (error) {
      cleanup();
      if (signal?.aborted) {
        throw error;
      }
      this.log('warn', 'Parallel HLS segment download failed; falling back to FFmpeg HLS input:', error);
      return null;
    }
  }

  async #downloadParallelResources(
    resources: HLSResource[],
    workDir: string,
    concurrency: number,
    files: Set<string>,
    signal?: AbortSignal
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let nextIndex = 0;
    let completeCount = 0;
    let downloadedSize = 0;
    const worker = async () => {
      while (true) {
        controller.signal.throwIfAborted();
        const resource = resources[nextIndex++];
        if (!resource) return;
        const filePath = path.resolve(workDir, resource.filename);
        files.add(filePath);
        files.add(`${filePath}.part`);
        downloadedSize += await this.#downloadResourceWithRetries(resource, filePath, controller.signal);
        completeCount++;
        if (completeCount === resources.length || completeCount % 25 === 0) {
          this.log('debug', `Downloaded ${completeCount}/${resources.length} HLS resources (${Math.round(downloadedSize / 1024)} KiB)`);
        }
      }
    };
    try {
      const workers = Array.from({ length: concurrency }, () => worker().catch((error: unknown) => {
        controller.abort(error);
        throw error;
      }));
      const results = await Promise.allSettled(workers);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async #downloadResourceWithRetries(resource: HLSResource, filePath: string, signal: AbortSignal) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.request.maxRetries; attempt++) {
      signal.throwIfAborted();
      try {
        const download = await this.#fetcher.prepareDownload({
          url: resource.url,
          srcEntity: this.srcEntity,
          destFilePath: filePath,
          setReferer: true,
          signal,
          byteRange: resource.byteRange
        });
        const result = await download.start({ destFilePath: filePath, tmpFilePath: `${filePath}.part` });
        if (resource.expectedSize !== undefined && fs.lstatSync(result.tmpFilePath).size !== resource.expectedSize) {
          result.discard();
          throw new Error(`HLS resource ${resource.index + 1} must contain ${resource.expectedSize} bytes`);
        }
        result.commit();
        return fs.lstatSync(filePath).size;
      }
      catch (error) {
        for (const file of [filePath, `${filePath}.part`]) {
          if (fs.existsSync(file)) this.fsHelper.unlink(file);
        }
        signal.throwIfAborted();
        lastError = error;
        if (attempt < this.config.request.maxRetries) {
          this.log('debug', `Retry HLS resource ${resource.index + 1} (${attempt + 1}/${this.config.request.maxRetries})`);
        }
      }
    }
    throw lastError;
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

  async #pickVariant(signal?: AbortSignal): Promise<PickVariantResult> {
    const { contents: m3u8, lastUrl } = await this.#fetcher.get({
      url: this.src,
      type: 'm3u8',
      maxRetries: this.config.request.maxRetries,
      signal
    });
    this.#playlistBase = lastUrl || this.src;
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
        ...(selected ? this.#getParallelSegmentDownloadSrcForVariant(selected, manifest) : {
          parallelSegmentDownloadSrc: null, parallelSegmentDownloadSkipReason: 'no media variant selected'
        })
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
      src: new URL(selected.uri, this.#playlistBase).href,
      resolution: this.#getResolutionString(selected),
      protected: selected.protected,
      ...this.#getParallelSegmentDownloadSrcForVariant(selected, manifest)
    };
  }

  async #getProtectionStatus(variants: PlaylistItem[], signal?: AbortSignal): Promise<Variant[]> {
    return await Promise.all(variants.map((variant) =>
      this.#fetcher.get({
        url: new URL(variant.uri, this.#playlistBase).href,
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
    return parseHLSPlaylist(m3u8);
  }

  #getParallelSegmentDownloadSrcForVariant(variant: PlaylistItem, manifest: Manifest) {
    const parallelSegmentDownloadSrc = new URL(variant.uri, this.#playlistBase).href;
    if (variant.attributes.AUDIO) {
      const renditions = Object.values(manifest.mediaGroups?.AUDIO?.[variant.attributes.AUDIO] || {});
      const audio = renditions.find((r) => r.default) || renditions.find((r) => r.autoselect) || renditions[0];
      if (!audio) {
        return { parallelSegmentDownloadSrc: null, parallelSegmentDownloadSkipReason: 'selected variant references a missing audio group' };
      }
      if (audio.uri) {
        return { parallelSegmentDownloadSrc, parallelAudioDownloadSrc: new URL(audio.uri, this.#playlistBase).href };
      }
    }
    return { parallelSegmentDownloadSrc };
  }

  #getResolutionString(item: PlaylistItem) {
    if (item.attributes.RESOLUTION?.width && item.attributes.RESOLUTION?.height) {
      return `${item.attributes.RESOLUTION.width}x${item.attributes.RESOLUTION.height}`;
    }
    return null;
  }
}
