import * as path from 'path'
import { getContextFromFile } from './selfContext'
import { containFile, escapeRegExpChar, isStylesheet } from './utils'

type Module = NodeJS.Module
type LoaderContext = import('webpack').loader.LoaderContext

const matchModuleImport = /^~(?:[^/]+|[^/]+\/|@[^/]+\/[^/]+|@[^/]+\/?|@[^/]+\/[^/]+\/)$/

export async function resolveStyle(
  resolver: LoaderContext['resolve'],
  id: string,
  syntax: string,
  context: string
) {
  const extensions = [`.${syntax}`]
  if (syntax !== 'css') {
    extensions.unshift('.css')
  }
  const targets = getStyleTargets(id, extensions)
  for (const tar of targets) {
    try {
      return await new Promise((resolve, reject) => {
        resolver(context, tar, (err, result) => (err ? reject(err) : resolve(result)))
      }).then((res) => {
        if (!isStylesheet(`${res}`)) {
          return Promise.reject(new Error('Not a supported css file'))
        }
        return res as string
      })
    } catch (err) {}
  }
  throwModuleNotFoundError(id, context, targets)
}

export function getModuleFromCache(name: string) {
  let matcher
  let matchByPath = false
  if (path.isAbsolute(name)) {
    const context = getContextFromFile(name)
    if (context) {
      name = require(path.join(context, 'package.json')).name
    } else {
      const normalizedPath = path.normalize(name).toLowerCase()
      matcher = (id: string) => id.toLowerCase() === normalizedPath
      matchByPath = true
    }
  }
  if (!matcher) {
    const regx = new RegExp(String.raw`/node_modules/${escapeRegExpChar(name)}/`, 'i')
    matcher = (id: string) => regx.test(id.replace(/\\/g, '/'))
  }
  const modules = new Map<string, Module>()
  for (const [id, module] of Object.entries(require.cache)) {
    if (module && matcher(id)) {
      if (!matchByPath) {
        const context = getContextFromFile(id)
        if (!context) {
          continue
        }
        const pkg = require(path.join(context, 'package.json'))
        if (pkg.name !== name) {
          continue
        }
        if (
          ![pkg.main, pkg.module, 'index.js', 'index.mjs'].some((main) =>
            typeof main === 'string' ? path.join(context, main) === id : false
          )
        ) {
          continue
        }
      }
      modules.set(id, module)
    }
  }
  return modules
}

export function resolveCachedModulePath(name: string, paths = [process.cwd()]) {
  for (const [id] of getModuleFromCache(name)) {
    if (containFile(paths, id)) {
      return id
    }
  }
  return ''
}

export function resolveModulePath(name: string, paths = [process.cwd()]) {
  try {
    return require.resolve(name, { paths })
  } catch (err) {
    const cachedModulePath = resolveCachedModulePath(name, paths)
    if (cachedModulePath) {
      return cachedModulePath
    }
    throw err
  }
}

function normalizeTargets(targets: string[]) {
  const relativeFiles = new Set<string>()
  const moduleFiles = new Set<string>()
  for (const tar of targets) {
    const file = path.normalize(tar).replace(/\\/g, '/')
    if (!path.isAbsolute(file)) {
      relativeFiles.add(`./${file}`)
    }
    moduleFiles.add(file)
  }
  return [...new Set([...relativeFiles, ...moduleFiles])]
}

function getStyleTargets(id: string, extensions: string[]) {
  const ids = []
  if (matchModuleImport.test(id)) {
    id = path.resolve('node_modules', id.substr(1))
    ids.push(id)
    const context = getContextFromFile(id)
    if (context) {
      try {
        const pkg = require(path.join(context, 'package.json'))
        if (pkg.style) {
          ids.unshift(path.join(context, pkg.style))
        } else if (!pkg.main || !/\.css$/.test(pkg.main)) {
          ids.push(path.join(context, 'index.css'))
        }
      } catch (e) {}
    }
  } else {
    ids.push(`./${id}`, id)
  }

  const targets = []
  for (const id of ids) {
    targets.push(id)
    for (const ext of extensions) {
      if (!id.endsWith(ext)) {
        targets[id.startsWith('.') ? 'unshift' : 'push'](`${id}${ext}`)
      }
    }
  }

  return normalizeTargets(targets)
}

function throwModuleNotFoundError(name: string, context: string, paths: string[]): never {
  const error = new Error(`Can't resolve '${name}'
  in [ ${paths.join(',\n        ')} ] from ${path.relative(process.cwd(), context)}`)
  Object.defineProperty(error, 'code', {
    value: 'MODULE_NOT_FOUND',
  })
  throw error
}
