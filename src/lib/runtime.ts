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

var hasOwnProperty = Object.prototype.hasOwnProperty
var themeStorage = {} as { [name: string]: Theme }
var link: HTMLLinkElement | null = null
var abort: Function | null = null
var deactivate: Function | null = null
var defaultThemeName = ''

function removeLink() {
  if (link) {
    link.onerror = link.onload = null
    var parent = link.parentNode
    if (parent) {
      parent.removeChild(link)
    }
    link = null
  }
}

function createLink() {
  removeLink()
  link = document.createElement('link')
  link.rel = 'stylesheet'
  link.type = 'text/css'
  return link
}

function getContainer() {
  var parent = document.getElementsByTagName('head')[0] || document.body
  if (!parent) {
    throw new Error('Page is empty')
  }
  return parent
}

function insertLink(parent: HTMLElement, link: HTMLLinkElement) {
  parent.appendChild(link)
}

function createLoadHandler(name: string, href: string, callback: Function) {
  return function (event: any) {
    if (event.type === 'load') {
      callback(null)
    } else {
      var type = event && (event.type === 'load' ? 'missing' : event.type)
      var request = (event && event.target && event.target.href) || href
      var err = new Error('Loading theme chunk "' + name + '" failed.\n(' + href + ')') as any
      err.code = 'THEME_CHUNK_LOAD_FAILED'
      err.type = type || 'failed'
      err.request = request
      callback(err)
    }
  }
}

function createAbortHandler(name: string, href: string, reject: Function) {
  return function () {
    var err = new Error('Request for theme of "' + name + '" are aborted.\n(' + href + ')') as any
    err.code = 'THEME_CHUNK_LOAD_ABORTED'
    err.type = 'abort'
    err.request = href
    reject(err)
  }
}

function loadTheme(name: string, href: string) {
  return new Promise<void>(function (resolve, reject) {
    if (abort) {
      abort()
      abort = null
    }
    if (!href) {
      resolve()
    }
    var parent = getContainer()
    var link = createLink()
    abort = createAbortHandler(name, href, reject)
    link.onerror = link.onload = createLoadHandler(name, href, function (err: Error | null) {
      link.onerror = link.onload = abort = null
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
    link.href = href
    insertLink(parent, link)
  })
}

function activateTheme(name: string, href: string) {
  var promise: Promise<any>
  if (name === defaultThemeName) {
    removeLink()
    promise = Promise.resolve()
  } else {
    promise = loadTheme(name, href)
  }
  return promise.then(function () {
    if (deactivate) {
      deactivate()
    }
    return function (callback: Function) {
      deactivate = callback
    }
  })
}

function defineTheme(name: string, initPath: string) {
  var href = initPath
  var activated = false
  return Object.defineProperties(
    {},
    {
      name: { value: name },
      href: {
        set(path: any) {
          if (typeof path === 'string') {
            var prev = href
            href = path.trim()
            if (activated && prev !== href) {
              activateTheme(name, href).catch(function (err) {
                throw err
              })
            }
          }
        },
        get() {
          return href
        },
      },
      activated: {
        get() {
          return activated
        },
      },
      activate: {
        value: function () {
          if (activated) {
            return Promise.resolve(name)
          }
          return activateTheme(name, href).then(function (deactivate: Function) {
            activated = true
            deactivate(function () {
              activated = false
            })
            return name
          })
        },
      },
    }
  ) as Theme
}

function useThemes(themes: { name: string; path: string }[], defaultTheme: string) {
  defaultThemeName = defaultTheme
  var definedThemes = themes.map(function (item) {
    var theme
    var name = item.name
    var path = item.path
    if (!hasOwnProperty.call(themeStorage, name)) {
      theme = themeStorage[name] = defineTheme(name, path)
    } else {
      ;(theme = themeStorage[name]).href = path
    }
    return theme
  })
  if (
    !definedThemes.some(function (theme) {
      return theme.activated
    })
  ) {
    var def = definedThemes.filter(function (theme) {
      return theme.name === defaultThemeName
    })[0]
    if (def) {
      def.activate()
    }
  }
  return definedThemes
}

export default useThemes
