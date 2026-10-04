import type { Post, Product } from "../entities/index.js";
import { isYouTubeEmbed } from "../entities/Downloadable.js";
import { type LogLevel } from "../utils/logging/Logger.js";
import type Logger from "../utils/logging/Logger.js";
import { commonLog } from "../utils/logging/Logger.js";
import { type DownloaderConfig } from "./Downloader.js";

export type IncludeCriteriaCheckPostResult = {
  ok: true;
} | {
  ok: false;
  reason: 'unviewable' | 'unmetMediaTypeCriteria' | 'notInTier' | 'publishDateOutOfRange';
};

export type IncludeCriteriaCheckProductResult = {
  ok: true;
} | {
  ok: false;
  reason: 'unviewable' | 'publishDateOutOfRange';
};


export class IncludeCriteriaHelper {
  name: 'IncludeCriteriaHelper';

  protected logger?: Logger | null;

  constructor(logger?: Logger | null) {
    this.logger = logger;
  }

  checkPost(post: Post, config: DownloaderConfig<Post>): IncludeCriteriaCheckPostResult {
    // -- 1. Viewability
    if (!post.isViewable && !config.include.lockedContent) {
      return {
        ok: false,
        reason: 'unviewable'
      };
    }

    // -- 2. Config option 'include.postsWithMediaType'
    const postsWithMediaType = config.include.postsWithMediaType;
    if (postsWithMediaType !== 'any') {
      const hasAttachments = post.attachments.length > 0;
      const hasAudio = !!post.audio || !!post.audioPreview;
      const hasImages = post.images.length > 0;
      const hasVideo = !!post.video || !!post.videoPreview || !!(post.embed && (post.embed.type === 'videoEmbed' || isYouTubeEmbed(post.embed)));
      const isPodcast = post.postType === 'podcast'

      let skip = false;
      if (postsWithMediaType === 'none') {
        skip = hasAttachments || hasAudio || hasImages || hasVideo;
      }
      else if (Array.isArray(postsWithMediaType)) {
        skip = !(
          (postsWithMediaType.includes('attachment') && hasAttachments) ||
          (postsWithMediaType.includes('audio') && hasAudio) ||
          (postsWithMediaType.includes('image') && hasImages) ||
          (postsWithMediaType.includes('video') && hasVideo) ||
          (postsWithMediaType.includes('podcast') && isPodcast && (hasAudio || hasVideo)));
      }

      if (skip) {
        this.log('debug', 'Match criteria failed:', `config.include.postsWithMediaType: ${JSON.stringify(postsWithMediaType)} <-> post #${post.id}:`, {
          hasAttachments,
          hasAudio,
          hasImages,
          hasVideo
        });
        return {
          ok: false,
          reason: 'unmetMediaTypeCriteria'
        };
      }
    }

    // -- 3. Config option 'include.postsInTier'
    const postsInTier = config.include.postsInTier;
    const isAnyTier = postsInTier === 'any' || postsInTier.includes('any');
    if (!isAnyTier) {
      const applicableTierIds = postsInTier.filter((id) => post.campaign?.rewards.find((r) => r.id === id));
      if (!post.campaign) {
        this.log('warn', 'config.include.postsInTier: ignored - post missing campaign info');
      }
      else {
        this.log('debug', 'config.include.postsInTier: applicable tier IDs:', applicableTierIds);
      }
      let skip = false;
      if (!post.campaign) {
        skip = false;
      }
      else if (applicableTierIds.length === 0) {
        skip = true;
      }
      else if (!post.tiers.find((tier) => tier.id === 'patrons')) {
        skip = applicableTierIds.every((id) => !post.tiers.find((tier) => tier.id === id));
      }
      if (skip) {
        this.log('debug', 'Match criteria failed:', `config.include.postsInTier: ${JSON.stringify(applicableTierIds)} <-> post #${post.id}:`, post.tiers);
        return {
          ok: false,
          reason: 'notInTier'
        };
      }
      if (post.campaign) {
        this.log('debug', 'Match criteria OK:', `config.include.postsInTier: ${JSON.stringify(applicableTierIds)} <-> post #${post.id}:`, post.tiers);
      }
    }

    // -- 4. Config option 'include.postsPublished'
    if (this.isPublishDateOutOfRange(post, config)) {
      return {
        ok: false,
        reason: 'publishDateOutOfRange'
      };
    }

    return {
      ok: true
    };
  }

  checkProduct(product: Product, config: DownloaderConfig<Product>): IncludeCriteriaCheckProductResult {
    // -- 1. Viewability
    if (!product.isAccessible && !config.include.lockedContent) {
      return {
        ok: false,
        reason: 'unviewable'
      };
    }

    // -- 2. Config option 'include.productsPublished'
    if (this.isPublishDateOutOfRange(product, config)) {
      return {
        ok: false,
        reason: 'publishDateOutOfRange'
      };
    }

    return {
      ok: true
    };
  }

  protected isPublishDateOutOfRange<T extends Post | Product>(
    entity: T,
    config: DownloaderConfig<T>
  ) {
    const publishedAfter = entity.type === 'post' ? config.include.postsPublished.after : config.include.productsPublished.after;
    const publishedBefore = entity.type === 'post' ? config.include.postsPublished.before : config.include.productsPublished.before;
    if (publishedAfter || publishedBefore) {
      const targetPublishedAt = entity.publishedAt;
      let parsedPublishedAt: Date | null = null;
      if (!targetPublishedAt) {
        this.log('warn', `config.include.productsPublished: ignored - ${entity.type} #${entity.id} missing publish date`);
      }
      else {
        try {
          parsedPublishedAt = new Date(targetPublishedAt);
        }
        catch (error: any) {
          this.log('error', `Failed to parse publish date of ${entity.type} #${entity.id} ("${targetPublishedAt}"): `, error);
          this.log('warn', `config.include.productsPublished: ignored - publish date of ${entity.type} #${entity.id} could not be parsed`);
        }
      }
      let skip = false;
      if (parsedPublishedAt) {
        const isAfter = publishedAfter ? parsedPublishedAt.getTime() >= publishedAfter.valueOf().getTime() : true;
        const isBefore = publishedBefore ? parsedPublishedAt.getTime() < publishedBefore.valueOf().getTime() : true;
        skip = !isAfter || !isBefore;
        let eq: string | null = null;
        if (publishedAfter && publishedBefore) {
          eq = `${publishedAfter.toString()} <= *${targetPublishedAt}* < ${publishedBefore.toString()}`;
        }
        else if (publishedAfter) {
          eq = `${publishedAfter.toString()} <= *${targetPublishedAt}*`;
        }
        else if (publishedBefore) {
          eq = `*${targetPublishedAt}* < ${publishedBefore.toString()}`;
        }
        if (eq) {
          if (skip) {
            // this.log('warn', `Skipped downloading ${entity.type} #${entity.id}: publish date out of range`);
            this.log('debug', `Publish date test failed for ${entity.type} #${entity.id}: ${eq}`);
          }
          else {
            this.log('debug', `Publish date test OK for ${entity.type} #${entity.id}: ${eq}`);
          }
        }
        return skip;
      }
    }
    return false;
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.logger, level, this.name, ...msg);
  }
}