[**patreon-dl**](../README.md)

***

[patreon-dl](../README.md) / ImageMediaItem

# Type Alias: ImageMediaItem\<T\>

> **ImageMediaItem**\<`T`\> = `T` *extends* `"single"` ? [`SingleImageMediaItem`](../interfaces/SingleImageMediaItem.md) : `T` *extends* `"default"` ? [`DefaultImageMediaItem`](../interfaces/DefaultImageMediaItem.md) : `T` *extends* `"campaignCoverPhoto"` ? [`CampaignCoverPhotoMediaItem`](../interfaces/CampaignCoverPhotoMediaItem.md) : `T` *extends* `"postCoverImage"` ? [`PostCoverImageMediaItem`](../interfaces/PostCoverImageMediaItem.md) : `T` *extends* `"postThumbnail"` ? [`PostThumbnailMediaItem`](../interfaces/PostThumbnailMediaItem.md) : `T` *extends* `"collectionThumbnail"` ? [`CollectionThumbnailMediaItem`](../interfaces/CollectionThumbnailMediaItem.md) : `never`

Defined in: [src/entities/MediaItem.ts:90](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/entities/MediaItem.ts#L90)

## Type Parameters

### T

`T` *extends* [`ImageType`](ImageType.md)
