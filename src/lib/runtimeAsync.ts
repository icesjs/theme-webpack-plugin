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
var currentLink: HTMLLinkElement | null = null
var abort: Function | null = null
var deactivate: Function | null = null
var defaultThemeName = ''

function removeLink(link: HTMLLinkElement | null) {
  if (link) {
    var parent = link.parentNode
    if (parent) {
      parent.removeChild(link)
    }
  }
}

function createLink(loadHandler: (event: any) => Error | null) {
  var link = document.createElement('link')
  link.rel = 'stylesheet'
  link.type = 'text/css'
  link.onerror = link.onload = function (event: any) {
    link.onerror = link.onload = null
    if (loadHandler(event)) {
      removeLink(link)
    } else {
      removeLink(currentLink)
      currentLink = link
    }
  }
  return link
}

function getContainer() {
  var parent = document.getElementsByTagName('head')[0] || document.body
  if (!parent) {
    throw new Error('Page is empty')
  }
  return parent
}

function createLoadHandler(name: string, href: string, callback: Function) {
  return function (event: any) {
    var err
    if (event.type === 'load') {
      err = null
    } else {
      var type = event && (event.type === 'load' ? 'missing' : event.type)
      var request = (event && event.target && event.target.href) || href
      err = new Error('Loading theme chunk "' + name + '" failed.\n(' + href + ')') as any
      err.code = 'THEME_CHUNK_LOAD_FAILED'
      err.type = type || 'failed'
      err.request = request
    }
    callback(err)
    return err
  }
}

function createAbortHandler(name: string, link: HTMLLinkElement, reject: Function) {
  return function () {
    link.onerror = link.onload = null
    removeLink(link)
    var href = link.href
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
      removeLink(currentLink)
      return resolve()
    }
    var parent = getContainer()
    var link = createLink(
      createLoadHandler(name, href, function (err: Error | null) {
        abort = null
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    )
    abort = createAbortHandler(name, link, reject)
    link.href = href
    parent.appendChild(link)
  })
}

function activateTheme(name: string, href: string) {
  return loadTheme(name, name === defaultThemeName ? '' : href).then(function () {
    if (deactivate) {
      deactivate()
    }
    return function (callback: Function) {
      deactivate = callback
    }
  })
}

function defineTheme(name: string, initPath: string) {
  var href = initPath.trim()
  var activated = false

  var activate = function () {
    return activateTheme(name, href).then(function (deactivate: Function) {
      activated = true
      deactivate(function () {
        activated = false
      })
      return name
    })
  }

  return Object.defineProperties(
    {},
    {
      name: { value: name },
      href: {
        set(path: any) {
          if (typeof path !== 'string') {
            return
          }
          var prev = href
          href = path.trim()
          if (activated && prev !== href) {
            activate().then()
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
          return activate()
        },
      },
    }
  ) as Theme
}

function registerThemes(themes: { name: string; path: string }[], defaultTheme: string) {
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

export default registerThemes
