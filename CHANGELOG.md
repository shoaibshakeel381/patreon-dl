# Changelog

3.9.0
- Fix "initial data not found" error for certain targets ([#134](https://github.com/patrickkfkan/patreon-dl/issues/134)).
- Fix order of images in post content ([patreon-dl-gui#60](https://github.com/patrickkfkan/patreon-dl-gui/issues/60)).
- Support `media.index` field in `media.filename.format`.
- Handle conditional separators properly in filename format patterns.
- Browse: use slugified links.
- Minor bug fixes.

3.8.1
- YT embeds: obtain images directly from YT instead of Patreon API data, since the latter could give 0-byte content ([@Fabelwesen](https://github.com/Fabelwesen) - [#120](https://github.com/patrickkfkan/patreon-dl/issues/120)).

3.8.0
- Add support for custom URLs (creators hosting Patreon pages on their own domains) ([@lucasoskorep](https://github.com/lucasoskorep) - [PR #129](https://github.com/patrickkfkan/patreon-dl/pull/129)).
- Fix YT download errors ([#132](https://github.com/patrickkfkan/patreon-dl/issues/132)).
- Browse: set title tag based on content ([#127](https://github.com/patrickkfkan/patreon-dl/issues/127)).
- CLI: add `--list-posts` / `--list-posts-uid` ([#126](https://github.com/patrickkfkan/patreon-dl/issues/126)).

3.7.1
- Check and skip download of Patreon-hosted videos that are protected by DRM; add `include.protectedMedia` / `protected.media` option.
- Fix campaign not found when targeting collections ([#124](https://github.com/patrickkfkan/patreon-dl/issues/124)).

v3.7.0
- Vimeo download script: fetch full player URL ([#118](https://github.com/patrickkfkan/patreon-dl/issues/118))
- Fix downloaded posts missing content / teaser ([@Fabelwesen](https://github.com/Fabelwesen) - [#119](https://github.com/patrickkfkan/patreon-dl/issues/119))
- Add "max content width" option to browse settings ([#122](https://github.com/patrickkfkan/patreon-dl/issues/122))
- Map inline post links to local server routes (contrib by [@Fabelwesen](https://github.com/Fabelwesen) - [#121](https://github.com/patrickkfkan/patreon-dl/issues/121))
- Support additional fields in `media.filename.format` ([patreon-dl-gui#51](https://github.com/patrickkfkan/patreon-dl-gui/issues/51))
- YT downloader: fix error in n/sig decipher function extraction

v3.6.1
- Fix Embedly download script error on retrying with alternative URL.

v3.6.0
- Browse: affix nav links (previous / next post) to viewport bottom if post content overflows ([patreon-dl-gui#41](https://github.com/patrickkfkan/patreon-dl-gui/issues/41))
- Fix error when Deno path contains spaces ([patreon-dl-gui#42](https://github.com/patrickkfkan/patreon-dl-gui/issues/42))
- Add SproutVideo download script ([patreon-dl-gui#43](https://github.com/patrickkfkan/patreon-dl-gui/issues/43))
- Fix YouTube download returning "auth required" error

v3.5.0
- Add support for downloading from "shop" URLs (e.g. `https://www.patreon.com/<creator>/shop`). This will download all products from a creator's shop.
  - Add `productsPublished` / `products.published.after` / `products.published.before` option to set publish date criteria of products included in download.
  - Since `stopOn` / `stop.on` option now also applies to products, the `postPreviouslyDownloaded` and `postPublishDateOutOfRange` values have been deprecated in favor of `previouslyDownloaded` and `publishDateOutOfRange`, respectively.
- Add Collections support. Collection info is now saved when downloading posts. This means you can browse posts by collection. ([#107](https://github.com/patrickkfkan/patreon-dl/issues/107))
- (Browse) Add search functionality ([#106](https://github.com/patrickkfkan/patreon-dl/issues/106))
- Add Tags support. Tag info is now saved when downloading posts. This means you can filter posts by tag.
- Add `include.mediaThumbnails` option

v3.4.0
- Fix "no posts found" on "cw" pages ([patreon-dl-gui#30](https://github.com/patrickkfkan/patreon-dl-gui/issues/30))
- Fix YouTube streams returning 403 error ([patreon-dl-gui#31](https://github.com/patrickkfkan/patreon-dl-gui/issues/31))
- Add `pathToDeno` / `--deno` / `path.to.deno` option (used by built-in YouTube downloader)
- Merged PRs:
  - Allow directory to be a symlink ([@piperswe](https://github.com/piperswe) - [#101](https://github.com/patrickkfkan/patreon-dl/pull/101))
  - Add Github actions ([@piperswe](https://github.com/piperswe) - [#102](https://github.com/patrickkfkan/patreon-dl/pull/102))
  - Add `maxVideoResolution` / `max.video.resolution` option to limit video downloads to a maximum resolution (see [example.conf](./example.conf)) ([@eisenbruch](https://github.com/eisenbruch) - [#105](https://github.com/patrickkfkan/patreon-dl/pull/105)) - extended to include site-hosted videos

v3.3.1
- Fix bugs affecting library usage:
  - `DB.getInstance()` returning same instance despite different DB path
  - `API.getInstance()` returning same instance despite different DB instance
  - DB not closed when downloader ends or web server stops

v3.3.0
- Fix:
  - YouTube stream fetching error ([patreon-dl-gui#28](https://github.com/patrickkfkan/patreon-dl-gui/issues/28))
  - Unsupported option error with FFmpeg v7.1.0 ([#97](https://github.com/patrickkfkan/patreon-dl/issues/97))
- Browse:
  - Add next / previous links to post page ([#93](https://github.com/patrickkfkan/patreon-dl/issues/93))
  - Fix media filter error when tier selected but not "Post"
- Process linked attachments in body of posts ([patreon-dl-gui#27](https://github.com/patrickkfkan/patreon-dl-gui/issues/27))
- Some DB optimizations (contrib by @[piperswe](https://github.com/piperswe) - PR #[95](https://github.com/patrickkfkan/patreon-dl/pull/95))

v3.2.1
- Fix log file path sometimes not sanitized properly on Windows
- API: add support for passing request options to `getCampaign()`
- CLI: add support for using request options from conf file when running with `--list-tiers` / `--list-tiers-uid`

v3.2.0
- Fix:
  - "Initial data not found" error in `patreon.com/cw` pages ([#85](https://github.com/patrickkfkan/patreon-dl/issues/85)) and custom-domain pages
  - FFmpeg v7.x compatibility issues ([#86](https://github.com/patrickkfkan/patreon-dl/issues/86))
  - Dry-run mode executing ops that should have been skipped
  - Wrong log file path returned in some cases
  - Various YouTube downloading issues
- Add:
  - Support passing options to `yt-dlp` in Vimeo download script
  - Support case-sensitivity flag in `config.include.mediaByFilename` options
- Browse:
  - Show inline images within post body
  - Show YouTube embed HTML content if video not downloaded ([#87](https://github.com/patrickkfkan/patreon-dl/issues/87))
  - Display "show more" toggle for long post bodies
- API:
  - `Downloader.getCampaign(params)`: enable lookup by `params.campaignId`

v3.1.0
- Defer database initialization until downloader starts
- UI: fix post column width possibly exceeding screen width
- Add `request.userAgent` option

v3.0.0
- Add support for browsing downloaded content through integrated web server. Note: this feature will not work for downloads made with previous versions of `patreon-dl`.

v2.4.3
- Fix YouTube embeds failing to download due to YT changes
- Add fallback download logic to Vimeo download script
- Fix error when downloading video ([#75](https://github.com/patrickkfkan/patreon-dl/issues/75))

v2.4.2
- Fix YouTube embeds failing to download due to YT changes
- Fix slow YouTube downloads ([#66](https://github.com/patrickkfkan/patreon-dl/issues/66))
- Other minor fixes

v2.4.1
- Fix Vimeo download script obtaining and downloading from player URL in embed HTML ([#65](https://github.com/patrickkfkan/patreon-dl/issues/65))
- Add `post-url` and `cookie` to available external downloader exec params
- API changes (non-breaking):
  - Expose `cookie` in `DownloaderConfig`


v2.4.0
- Support additional URL format: `https://www.patreon.com/cw/<creator>/posts`
- Add `stopOn` option ([#63](https://github.com/patrickkfkan/patreon-dl/issues/63))
- Add `proxy` option ([#62](https://github.com/patrickkfkan/patreon-dl/issues/62))
- Fix Vimeo download script
- Fix YouTube embeds failing to download due to YT changes
- API changes (non-breaking):
  - Expose `URLHelper`, `FetcherError`
  - Add `getDefaultDownloaderOptions()`
  - `ConsoleLogger` / `FileLogger`: add `getDefaultConfig()`
- Required Node version bumped to v20.18.1 or higher

v2.3.0
- Add `podcast` type to `include.postsWithMediaType` option
- Add `include.comments` option
- Fix videos not downloaded in podcast-type posts ([#56](https://github.com/patrickkfkan/patreon-dl/issues/56))

v2.2.0
- Widen scope of external downloaders to any type of embed (previously only works for video embeds) ([#51](https://github.com/patrickkfkan/patreon-dl/issues/51))
- YouTube downloading now covers embedded YT links
- Fix attachment filenames sometimes have wrong extension

v2.1.1
- Fix multiple abort signal listeners triggering warning ([#48](https://github.com/patrickkfkan/patreon-dl/issues/48))
- Fix YouTube embeds failing to download due to YT changes ([#50](https://github.com/patrickkfkan/patreon-dl/issues/50))
- Fix inline images of posts sometimes missing from downloads
- Fix status cache: target marked as downloaded without errors despite having errors at task creation stage

v2.1.0
- Fix attachment downloads following API changes ([#40](https://github.com/patrickkfkan/patreon-dl/issues/40))
- Add support for URL format: `https://www.patreon.com/c/<creator>/posts`
- Check and resolve conflicting destination paths ([#38](https://github.com/patrickkfkan/patreon-dl/issues/38))
- Parse inline content media ([#40](https://github.com/patrickkfkan/patreon-dl/issues/40))

v2.0.0
- Replace [node-fetch](https://github.com/node-fetch/node-fetch) with Fetch API; required Node.js version bumped to v18 or higher.
- Update dependencies and libraries
- New `include` options:
  - `include.postsPublished` ([#29](https://github.com/patrickkfkan/patreon-dl/issues/29))
  - `include.mediaByFilename` ([#33](https://github.com/patrickkfkan/patreon-dl/issues/33))
- Bug fixes:
  - 403 error when downloading YouTube embeds
  - Only first of multiple targets downloaded ([#26](https://github.com/patrickkfkan/patreon-dl/issues/26))

v1.7.0
- Download next batch of posts before expiry of 'next' URL (fixes [#22](https://github.com/patrickkfkan/patreon-dl/issues/22))
- Add `--dry-run` / `dryRun` option
- Support URL format `https://www.patreon.com/posts/<post_id>`

v1.6.2
- Fix 'campaign ID not found' error due to Patreon changes

v1.6.1
- Fix file extension sometimes missing ([#20](https://github.com/patrickkfkan/patreon-dl/issues/20))

v1.6.0
- Add external downloader support for embedded videos

v1.5.0
- Add support for fetching by user ID instead of creator vanity ([#18](https://github.com/patrickkfkan/patreon-dl/issues/18)):
  - Support URL format `https://www.patreon.com/user/posts?u=<user_id>`
  - Overload `PatreonDownloader.getCampaign()` to take `userId` arg
  - CLI: add `--list-tiers-uid`

v1.4.0
- Add ability to filter posts by tier ([#8](https://github.com/patrickkfkan/patreon-dl/issues/8))
- CLI:
  - Add `--list-tiers`
  - Add support for target-specific `include` options
  - Print summary at the end for multiple target URLs ([#13](https://github.com/patrickkfkan/patreon-dl/issues/13))

v1.3.0
- Add support for multiple target URLs
- Add `content.publishDate` field to the content dir name format ([PR #12](https://github.com/patrickkfkan/patreon-dl/pull/12) by [kazuoteramoto](https://github.com/kazuoteramoto))
- Bug fixes

v1.2.2
- Fix wrong file extension for some content types
- Fix YouTube API requests throwing errors due to YT changes

v1.2.1
- Bug fixes

v1.2.0
- Add support for granular control over:
  - posts to include in download based on type of media contained
  - the type of media to download
- Bug fixes

v1.1.1
- Fix initial data parsing following Patreon changes

v1.1.0
- Add support for downloading embedded YouTube videos

v1.0.1
- Fix missing types when importing as library
- Fix link in this README

v1.0.0
- Initial release