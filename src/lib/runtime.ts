/***
 * 浏览器端运行时代码。
 * 使用es5。可以使用ts类型标注。
 */
type Theme = {
  readonly name: string
  readonly activated: boolean
  readonly activate: () => Promise<string>
  href: string
}

function registerThemes(themes: { name: string; path: string }[], defaultTheme: string) {
  return [] as Theme[]
}

export default registerThemes
