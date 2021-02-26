import vm, { Context } from 'vm'
import * as path from 'path'
import * as babel from '@babel/core'
import { PluginItem } from '@babel/core'
import { DOMWindow } from 'jsdom'
import { getHashDigest } from 'loader-utils'
import { toAsyncFunction, toCallExpression } from './asyncConverter'
import { ensureFileExtension, getQueryString, hasOwnProperty, trimUndefined } from './utils'

type LoaderContext = import('webpack').loader.LoaderContext

export type VirtualModuleExports = {
  readonly __esModule?: boolean
  default?: any
  [p: string]: any
}

export type VirtualModule = {
  readonly id: string
  readonly parents: Set<VirtualModule>
  promise: PromiseLike<any>
  exports: VirtualModuleExports
  loaded: boolean
}

export type AsyncWebpackRequire = (this: WebpackModuleContext, request: string) => any

export type WebpackPublicPath = string | ((file: string) => Promise<string>)

export interface WebpackModuleContext {
  module: VirtualModule
  exports: VirtualModuleExports
  readonly require: AsyncWebpackRequire
  readonly __non_webpack_require__: NodeRequire
  readonly __resourceQuery: string
  readonly __webpack_require__: AsyncWebpackRequire
  readonly __webpack_public_path__: WebpackPublicPath
}

interface VirtualWebpackModule extends WebpackModuleContext, Context, DOMWindow {}

// 私有的模块属性
const privateModuleProperties = /^(?:parents|promise)$/
// 标识虚拟模块数据
const virtualModuleSymbol = Symbol('__virtualModule')
// babel代码编译缓存
const babelCodeCache = new Map<string, string>()
// 默认的html内容
const defaultFakeHTMLContent = `<html lang='en'><head><title></title></head><body/></html>`
// 浏览器窗口环境模拟
let fakeBrowser: DOMWindow | null = null

// 获取浏览器环境模拟
function getFakeBrowser() {
  if (!fakeBrowser) {
    try {
      const { JSDOM } = require('jsdom')
      fakeBrowser = new JSDOM(defaultFakeHTMLContent, {
        url: 'http://localhost:8080',
        runScripts: 'outside-only',
      })
      const close = () => {
        if (fakeBrowser) {
          fakeBrowser.window.close()
          fakeBrowser = null
        }
      }
      process.on('SIGINT', close)
      process.on('SIGTERM', close)
      process.on('exit', close)
    } catch (e) {}
  }
  return fakeBrowser || null
}

// 获取浏览器窗口环境模拟
function getBrowserWindow() {
  return getFakeBrowser()?.window || null
}

// 获取浏览器的虚拟机上下文对象
function getBrowserContext() {
  return getFakeBrowser()?.getInternalVMContext() || null
}

// 获取模块缓存的容器
function getModuleCache(loaderContext: LoaderContext): Map<string, VirtualModule> {
  const { data } = loaderContext
  if (!hasOwnProperty(data, virtualModuleSymbol)) {
    Object.defineProperty(data, virtualModuleSymbol, {
      value: new Map<string, VirtualModule>(),
    })
  }
  return Reflect.get(data, virtualModuleSymbol)
}

// 从缓存中获取模块
function getModuleFromCache(loaderContext: LoaderContext, id: string) {
  const cache = getModuleCache(loaderContext)
  id = path.normalize(id || '')
  if (cache.has(id)) {
    return cache.get(id)
  }
  return null
}

// 清理缓存与浏览器虚拟环境
function clear(loaderContext: LoaderContext) {
  getModuleCache(loaderContext).clear()
  const window = getBrowserWindow()
  if (window) {
    window.document.write(defaultFakeHTMLContent)
  }
}

// 转译代码
function transformCode(originalCode: string, filename: string, plugins: PluginItem[] = []) {
  return (
    babel.transform(originalCode, {
      plugins,
      babelrc: false,
      configFile: false,
      sourceType: 'unambiguous',
      filename: ensureFileExtension(filename, '.js'),
      presets: [
        [
          require('@babel/preset-env'),
          {
            modules: 'commonjs',
            targets: { node: 'current' },
          },
        ],
      ],
    })?.code || ''
  )
}

// 获取代码转换插件
function getTransformPlugins(webpackModule?: VirtualWebpackModule) {
  const plugins = [toAsyncFunction(['require', '__webpack_require__', '__webpack_public_path__'])]
  if (webpackModule) {
    const { __webpack_public_path__, module } = webpackModule
    if (typeof __webpack_public_path__ === 'function') {
      // 添加toAsyncFunction插件前面先处理
      plugins.unshift(toCallExpression('__webpack_public_path__', [module?.id || '']))
    }
  }
  return plugins
}

// 获取待运行的脚本代码
function getScriptCode(originalCode: string | [string, any]) {
  const [script, injectScript] = Array.isArray(originalCode) ? originalCode : [originalCode, '']
  return [
    script,
    injectScript
      ? typeof injectScript === 'function'
        ? `;(await (${injectScript})());`
        : `;(await (()=>{\n${injectScript}\n})());`
      : '',
  ]
}

// 使用虚拟机编译运行模块代码
async function evalModuleCode(
  originalCode: string | [string, any],
  filename: string,
  webpackModule: VirtualWebpackModule
): Promise<VirtualModule> {
  const [script, inject] = getScriptCode(originalCode)
  const hash = getHashDigest(Buffer.from(`${script}${inject}`), 'md4', 'hex', 32)
  let code: string

  if (babelCodeCache.has(hash)) {
    code = babelCodeCache.get(hash)!
  } else {
    // 先转换为commonjs代码
    const commonjs = transformCode(script, filename)
    // 再次将require转换为异步函数调用
    code = transformCode(
      `;(async ()=>{\n${commonjs}\n${inject}\n})().then(()=>module);`,
      filename,
      getTransformPlugins(webpackModule)
    )
    babelCodeCache.set(hash, code)
  }

  return vm.runInContext(
    code,
    vm.isContext(webpackModule) ? webpackModule : vm.createContext(webpackModule),
    {
      displayErrors: true,
      breakOnSigint: true,
    }
  )
}

// 运行虚拟机
async function runVirtualMachine(
  loaderContext: LoaderContext,
  moduleContext: WebpackModuleContext,
  sources: string | [string, any],
  sourcePath: string
) {
  const webpackModule: VirtualWebpackModule = Object.assign(
    // 虚拟的浏览器窗口环境
    Object.create(getBrowserContext()),
    // 当前要执行的模块上下文，让它继承浏览器环境
    moduleContext,
    {
      // 模块对象上的私有可写属性，通过代理屏蔽掉
      module: new Proxy(moduleContext.module, {
        get(target, prop, receiver) {
          return !privateModuleProperties.test(String(prop))
            ? Reflect.get(target, prop, receiver)
            : undefined
        },
      }),
    }
  )
  try {
    const module = await evalModuleCode(sources, sourcePath, webpackModule)
    return resolveModuleExports(module)
  } catch (err) {
    if (!(err instanceof Error)) {
      err = new Error(typeof err !== 'undefined' ? `${err}` : 'Virtual module runtime exception')
    }
    throw err
  }
}

// 定义虚拟commonjs模块
function defineVirtualModule(loaderContext: LoaderContext, id: string) {
  const module: VirtualModule =
    getModuleFromCache(loaderContext, id) ||
    Object.defineProperties(
      {
        loaded: false,
        promise: null,
        exports: {},
      },
      // 下面属性只读
      {
        id: { value: path.normalize(id || '') },
        parents: { value: new Set<VirtualModule>() },
      }
    )
  if (module.id) {
    getModuleCache(loaderContext).set(id, module)
  }
  return module
}

// 创建虚拟的webpack模块上下文对象
function createModuleContext(
  loaderContext: LoaderContext,
  moduleContext: Partial<WebpackModuleContext>,
  moduleId: string
) {
  const module = defineVirtualModule(loaderContext, moduleId)
  const requireContext = path.dirname(moduleId)
  const webpackRequireAsync = getAsyncWebpackRequire(loaderContext, module, requireContext)
  //
  const webpackModuleContext: WebpackModuleContext = Object.assign(
    Object.create(null),
    // 默认的上下文属性
    {
      __webpack_public_path__: '/',
      __non_webpack_require__: require,
      __resourceQuery: getQueryString(moduleId),
      __webpack_require__: (req: string) => webpackRequireAsync.call(webpackModuleContext, req),
    },
    // 调用方自定义的上下文属性
    trimUndefined<WebpackModuleContext>(moduleContext),
    // commonjs模块环境模拟
    {
      module,
      exports: module.exports,
      // 这里的 require 是我们在虚拟机里面运行的转译为异步调用的那个require
      require: (req: string) => webpackRequireAsync.call(webpackModuleContext, req),
    }
  )
  return webpackModuleContext
}

// 加载webpack模块
function loadWebpackModule(
  loaderContext: LoaderContext,
  moduleContext: WebpackModuleContext,
  request: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    loaderContext.loadModule(request, (err, source) => {
      if (err) {
        return reject(err)
      }
      // 继续运行新的模块代码
      try {
        const sourcePath = request.split('!').pop()!
        resolve(runVirtualMachine(loaderContext, moduleContext, source, sourcePath))
      } catch (e) {
        reject(e)
      }
    })
  })
}

// 处理模块导出兼容
function resolveModuleExports(module: VirtualModule) {
  // 模块的导出有可能是被模块代码本身覆写的，比如常见的 module.exports = xxx
  const { exports } = module
  const defaultExport = hasOwnProperty(exports, '__esModule', 'boolean') ? exports.default : exports
  module.loaded = true

  // 有些模块代码本身没做兼容处理，这里我们用一个代理，拦截default属性访问，并返回模块的默认导出
  return new Proxy(exports as any, {
    get(target, prop, receiver) {
      return prop === 'default' ? defaultExport : Reflect.get(target, prop, receiver)
    },
  })
}

// 根据请求资源解析模块的ID
function resolveModuleId(loaderContext: LoaderContext, context: string, resource: string) {
  return new Promise<string>((resolve, reject) => {
    // 使用webpack的resolver来解析资源
    loaderContext.resolve(context, resource, (err, res) => (err ? reject(err) : resolve(res)))
  })
}

// 检查循环依赖
function isCycleDependency(parentModule: VirtualModule, childModule: VirtualModule) {
  // 注意，这里一定要先将父模块添加进子模块的父依赖中，再进行父依赖检查
  childModule.parents.add(parentModule)

  // 聚集所有依赖的父级模块
  const parents = new Set<VirtualModule>()
  const join = (module: VirtualModule) => {
    parents.add(module)
    for (const parent of module.parents) {
      if (!parents.has(parent)) {
        join(parent)
      }
    }
  }

  join(parentModule)
  // 如果父模块依赖里面，包含当前模块，则是循环依赖
  return parents.has(childModule)
}

// 获取异步require方法，用于桥接commonjs的require到webpack的loadModule
function getAsyncWebpackRequire(
  loaderContext: LoaderContext,
  parentModule: VirtualModule,
  requireContext: string
) {
  //
  return async function (this: WebpackModuleContext, request: string) {
    const loadersAndResource = request.split('!')
    const resource = loadersAndResource.pop()!
    const moduleId = await resolveModuleId(loaderContext, requireContext, resource)
    const moduleContext = createModuleContext(loaderContext, this, moduleId)
    const { module } = moduleContext

    if (isCycleDependency(parentModule, module)) {
      // 如果存在循环依赖，则返回被依赖模块已经导出了的内容，这也是commonjs模块的默认做法
      return module.exports
    }
    const resourceRequest = [...loadersAndResource, moduleId].join('!')
    // 保存promise的原因是，如果有重复的模块请求，则返回已经处理中的promise
    return (module.promise =
      module.promise || loadWebpackModule(loaderContext, moduleContext, resourceRequest))
  }
}

/**
 * 使用虚拟机执行webpack模块，并返回模块的导出
 * 虽然抽取css，只需要执行一些简单的代码就行了，但这里也支持复杂代码的运行
 */
export default async function exec(
  loaderContext: LoaderContext,
  moduleContext: Partial<WebpackModuleContext>,
  source: string,
  injectScript?: any
) {
  try {
    const { resourcePath } = loaderContext
    return runVirtualMachine(
      loaderContext,
      createModuleContext(loaderContext, moduleContext, resourcePath),
      // 可注入一些代码到模块代码结尾，支持async函数
      // 注入代码可访问当前模块的上下文数据，可访问模拟的浏览器Window环境
      typeof injectScript !== 'undefined' ? [source, injectScript] : source,
      resourcePath
    )
  } catch (e) {
    throw e
  } finally {
    clear(loaderContext)
  }
}
