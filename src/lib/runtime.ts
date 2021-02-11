/***
 * 浏览器端运行时代码。
 * 使用es5。可以使用ts类型标注。
 */
type Theme = {
  readonly name: string
  readonly activated: boolean
  readonly activate: () => Promise<string>
}

var link: HTMLLinkElement | null = null
var abort: Function | null = null
var deactivate: Function | null = null

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

function createLoadHandler(name: string, path: string, callback: Function) {
  return function (event: any) {
    if (event.type === 'load') {
      callback(null)
    } else {
      var type = event && (event.type === 'load' ? 'missing' : event.type)
      var href = (event && event.target && event.target.href) || path
      var err = new Error('Loading theme chunk "' + name + '" failed.\n(' + href + ')') as any
      err.code = 'THEME_CHUNK_LOAD_FAILED'
      err.type = type || 'failed'
      err.request = href
      callback(err)
    }
  }
}

function createAbortHandler(name: string, path: string, reject: Function) {
  return function () {
    var err = new Error('Request for theme of "' + name + '" are aborted.\n(' + path + ')') as any
    err.code = 'THEME_CHUNK_LOAD_ABORTED'
    err.type = 'abort'
    err.request = path
    reject(err)
  }
}

function loadTheme(name: string, path: string) {
  return new Promise<void>(function (resolve, reject) {
    if (abort) {
      abort()
      abort = null
    }
    var parent = getContainer()
    var link = createLink()
    abort = createAbortHandler(name, path, reject)
    link.onerror = link.onload = createLoadHandler(name, path, function (err: Error | null) {
      link.onerror = link.onload = abort = null
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
    link.href = path
    insertLink(parent, link)
  })
}

function activateTheme(name: string, path: string, isDefault: boolean) {
  var promise: Promise<any>
  if (isDefault) {
    removeLink()
    promise = Promise.resolve()
  } else {
    promise = loadTheme(name, path)
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

function defineTheme(name: string, path: string, isDefault: boolean) {
  var activated = false
  return Object.defineProperties(
    {},
    {
      name: { value: name },
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
          return activateTheme(name, path, isDefault).then(function (deactivate: Function) {
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
  return themes.map(function (item) {
    var isDefault = item.name === defaultTheme
    var theme = defineTheme(item.name, item.path, isDefault)
    if (isDefault) {
      theme.activate().catch(function () {})
    }
    return theme
  })
}

export default useThemes
