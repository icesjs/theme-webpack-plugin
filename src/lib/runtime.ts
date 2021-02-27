/***
 * 非抽取主题模式下的主题切换同步运行时。
 * 使用es5。可以使用ts类型标注。
 */
type Theme = {
  readonly name: string
  readonly activated: boolean
  readonly activate: () => Promise<string>
  style?: string
}

var hasOwnProperty = Object.prototype.hasOwnProperty
var themeStorage = {} as { [name: string]: Theme }
var themeAttrName = 'data-theme'
var styleElement: HTMLStyleElement | null = null

function getContainer() {
  var parent = document.getElementsByTagName('head')[0] || document.body
  if (!parent) {
    throw new Error('Page is empty')
  }
  return parent
}

function insertStyle(style: string) {
  if (styleElement && styleElement.parentNode) {
    styleElement.parentNode.removeChild(styleElement)
  }
  if (style) {
    var parent = getContainer()
    styleElement = document.createElement('style')
    styleElement.type = 'text/css'
    styleElement.appendChild(document.createTextNode(style))
    parent.appendChild(styleElement)
  }
}

function activateTheme(name: string, style: string) {
  insertStyle(style)
  document.documentElement.setAttribute(themeAttrName, name)
}

function isActivated(name: string) {
  return document.documentElement.getAttribute(themeAttrName) === name
}

function defineTheme(name: string, style: string) {
  return Object.defineProperties(
    {},
    {
      name: { value: name },
      style: {
        set(content: any) {
          if (typeof content === 'string') {
            var prev = style
            if ((style = content.trim()) !== prev && isActivated(name)) {
              insertStyle(style)
            }
          }
        },
        get() {
          return style
        },
      },
      activated: {
        get() {
          return isActivated(name)
        },
      },
      activate: {
        value: function () {
          if (!isActivated(name)) {
            activateTheme(name, style)
          }
          return Promise.resolve(name)
        },
      },
    }
  ) as Theme
}

function registerThemes(
  themes: { name: string; style?: string }[],
  defaultTheme: string,
  attrName: string
) {
  themeAttrName = attrName
  var definedThemes = themes.map(function (item) {
    var theme
    var name = item.name
    var style = typeof item.style === 'string' ? item.style.trim() : ''
    if (!hasOwnProperty.call(themeStorage, name)) {
      theme = themeStorage[name] = defineTheme(name, style)
    } else {
      ;(theme = themeStorage[name]).style = style
    }
    return theme
  })
  if (
    !definedThemes.some(function (theme) {
      return theme.activated
    })
  ) {
    var def = definedThemes.filter(function (theme) {
      return theme.name === defaultTheme
    })[0]
    if (def) {
      def.activate()
    }
  }
  return definedThemes
}

export default registerThemes
