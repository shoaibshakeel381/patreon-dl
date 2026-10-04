[**patreon-dl**](../README.md)

***

[patreon-dl](../README.md) / PostDownloaderBootstrapData

# Interface: PostDownloaderBootstrapData

Defined in: [src/downloaders/Bootstrap.ts:29](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/downloaders/Bootstrap.ts#L29)

## Extends

- [`BootstrapData`](BootstrapData.md)

## Properties

### postFetch

> **postFetch**: \{ `postId`: `string`; `type`: `"single"`; \} \| \{ `campaignId?`: `string`; `filters?`: `Record`\<`string`, `any`\>; `type`: `"byUser"`; `vanity`: `string`; \} \| \{ `campaignId?`: `string`; `filters?`: `Record`\<`string`, `any`\>; `type`: `"byUserId"`; `userId`: `string`; \} \| \{ `campaignId?`: `string`; `collectionId`: `string`; `filters?`: `Record`\<`string`, `any`\>; `type`: `"byCollection"`; \} \| \{ `filePath`: `string`; `type`: `"byFile"`; \}

Defined in: [src/downloaders/Bootstrap.ts:31](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/downloaders/Bootstrap.ts#L31)

***

### targetURL

> **targetURL**: `string`

Defined in: [src/downloaders/Bootstrap.ts:11](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/downloaders/Bootstrap.ts#L11)

#### Inherited from

[`BootstrapData`](BootstrapData.md).[`targetURL`](BootstrapData.md#targeturl)

***

### type

> **type**: `"post"`

Defined in: [src/downloaders/Bootstrap.ts:30](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/downloaders/Bootstrap.ts#L30)

#### Overrides

[`BootstrapData`](BootstrapData.md).[`type`](BootstrapData.md#type)
