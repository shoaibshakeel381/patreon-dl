/**
 * Compiles a post-title pattern. JavaScript regex literals such as `/flower/i`
 * are accepted alongside plain pattern text such as `flower`.
 */
export function compilePostTitleRegex(pattern: string): RegExp {
  const literal = /^\/(.*)\/([dgimsuvy]*)$/.exec(pattern);
  if (literal) {
    return new RegExp(literal[1], literal[2]);
  }
  return new RegExp(pattern);
}
