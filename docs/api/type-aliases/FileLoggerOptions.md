[**patreon-dl**](../README.md)

***

[patreon-dl](../README.md) / FileLoggerOptions

# Type Alias: FileLoggerOptions\<T\>

> **FileLoggerOptions**\<`T`\> = [`ConsoleLoggerOptions`](../interfaces/ConsoleLoggerOptions.md) & `T` *extends* [`Downloader`](../enumerations/FileLoggerType.md#downloader) ? [`DownloaderFileLoggerOptions`](../interfaces/DownloaderFileLoggerOptions.md) : `T` *extends* [`Server`](../enumerations/FileLoggerType.md#server) ? [`ServerFileLoggerOptions`](../interfaces/ServerFileLoggerOptions.md) : `never`

Defined in: [src/utils/logging/FileLogger.ts:17](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/utils/logging/FileLogger.ts#L17)

## Type Parameters

### T

`T` *extends* [`FileLoggerType`](../enumerations/FileLoggerType.md)
