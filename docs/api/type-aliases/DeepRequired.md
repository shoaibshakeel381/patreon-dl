[**patreon-dl**](../README.md)

***

[patreon-dl](../README.md) / DeepRequired

# Type Alias: DeepRequired\<T, E\>

> **DeepRequired**\<`T`, `E`\> = `T` *extends* `E` ? `T` : `T` *extends* \[infer I\] ? \[`DeepRequired`\<`I`\>\] : `T` *extends* infer I[] ? `DeepRequired`\<`I`\>[] : `T` *extends* `object` ? `{ [P in keyof T]-?: DeepRequired<T[P]> }` : `T` *extends* `undefined` ? `never` : `T`

Defined in: [src/utils/Misc.ts:10](https://github.com/patrickkfkan/patreon-dl/blob/f4934f843afb682fff78767f9badb2782e7b594e/src/utils/Misc.ts#L10)

## Type Parameters

### T

`T`

### E

`E` = [`NoDeepTypes`](NoDeepTypes.md)
