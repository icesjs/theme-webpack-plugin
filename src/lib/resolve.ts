import * as path from 'path'
import * as fs from 'fs'
import { getContextFromFile, selfContext } from './selfContext'
import { containFile, isStylesheet } from './utils'

type Module = NodeJS.Module
type LoaderContext = import('webpack').loader.LoaderContext

const matchModuleImport = /^~(?:[^/]+|[^/]+\/|@[^/]+[/][^/]+|@[^/]+\/?|@[^/]+[/][^/]+\/)$/

export function escapeRegExpCharacters(str: string): string {
  return str.replace(/[|/\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d')
}

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
  throwModuleNotFoundError(id, targets)
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
    const regx = new RegExp(String.raw`/node_modules/${escapeRegExpCharacters(name)}/`, 'i')
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

export function isFromModule(name: string, file: string) {
  const context = getContextFromFile(file)
  if (context) {
    try {
      return require(path.join(context, 'package.json')).name === name
    } catch (e) {
      return false
    }
  }
  return false
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

export function resolveModule(name: string, paths?: string[]) {
  if (
    name !== 'webpack' &&
    !(resolveModule as any).webpack &&
    !__filename.startsWith(process.cwd())
  ) {
    // 因为 webpack 在当前模块中是个 peerDependency
    // 如果从当前模块中加载依赖了 webpack 的模块，可能会出现加载不到 webpack 的情况
    // 比如使用 link 命令创建当前模块的符号链接到当前工作目录时
    const webpack = path.join(selfContext, 'node_modules/webpack')
    if (!fs.existsSync(webpack)) {
      const target = path.dirname(resolveModulePath('webpack/package.json'))
      fs.symlinkSync(target, webpack, 'dir')
    }
    Object.defineProperty(resolveModule, 'webpack', {
      value: webpack,
    })
  }
  //
  return path.isAbsolute(name) ? require(name) : require(resolveModulePath(name, paths))
}

export function resolveWebpack(paths?: string[]) {
  return resolveModule('webpack', paths)
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

function throwModuleNotFoundError(name: string, paths: string[]): never {
  const error = new Error(`Can't resolve '${name}'
  in [${paths.join(',\n        ')}]`)
  Object.defineProperty(error, 'code', {
    value: 'MODULE_NOT_FOUND',
  })
  throw error
}
