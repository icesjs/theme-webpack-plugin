import vm from 'vm'
import * as path from 'path'
import * as babel from '@babel/core'
import { PluginItem } from '@babel/core'
import { DOMWindow } from 'jsdom'
import { getHashDigest } from 'loader-utils'
import { toAsyncFunction, toCallExpression } from './asyncConverter'
import { hasOwnProperty, isEsModuleExport } from './utils'

const virtualModuleSymbol = Symbol('__virtualModule')
const publicPathSymbol = Symbol('__publicPath')

type LoaderContext = import('webpack').loader.LoaderContext
type PublicPath = string | ((file: string) => Promise<string>)

type VirtualModuleExports = {
  readonly [virtualModuleSymbol]: symbol
  readonly __esModule?: boolean
  default?: any
  [p: string]: any
}

type VirtualModule = {
  readonly id: string
  readonly parents: Set<VirtualModule>
  promise: PromiseLike<VirtualModuleExports>
  exports: VirtualModuleExports
  loaded: boolean
}

type AsyncWebpackRequire = (request: string) => Promise<VirtualModule>
type VirtualModuleResolve = (module: VirtualModule) => void
type VirtualModuleReject = (reason: Error) => void

interface VirtualWebpackModule extends DOMWindow {
  resolve: VirtualModuleResolve
  reject: VirtualModuleReject
  module: VirtualModule
  exports: VirtualModule['exports']
  __webpack_public_path__: string
  __non_webpack_require__: NodeRequire
  __webpack_require__: AsyncWebpackRequire
  require: AsyncWebpackRequire
  hot?: null
}

// 浏览器环境模拟
let BrowserWindow: DOMWindow | null = null

// 浏览器环境模拟
function getBrowserWindow() {
  if (!BrowserWindow) {
    try {
      const { JSDOM } = require('jsdom')
      BrowserWindow = new JSDOM(`<html lang='en'><head><title></title></head><body/></html>`, {
        url: 'http://localhost:8080',
      }).window
    } catch (e) {}
  }
  return BrowserWindow
}

// 编译转换代码
function transformCode(originalCode: string, plugins: PluginItem[] = []) {
  return (
    babel.transform(originalCode, {
      plugins,
      filename: 'vm.js',
      babelrc: false,
      configFile: false,
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
function getTransformPlugin(loaderContext: LoaderContext, module: VirtualModule) {
  const plugin = [toAsyncFunction(['require', '__webpack_require__', '__webpack_public_path__'])]
  const publicPath = getPublicPath(loaderContext)
  if (typeof publicPath === 'function') {
    // 添加toAsyncFunction插件前面先处理
    plugin.unshift(toCallExpression('__webpack_public_path__', [module.id]))
  }
  return plugin
}

// 代码编译缓存
let codeCache = new Map<string, string>()

// 使用虚拟机编译运行模块代码
function evalModuleCode(
  loaderContext: LoaderContext,
  originalCode: string,
  webpackModule: VirtualWebpackModule
) {
  let code: string
  const hash = getHashDigest(Buffer.from(originalCode), 'md4', 'hex', 32)
  if (codeCache.has(hash)) {
    code = codeCache.get(hash)!
  } else {
    // 转换代码
    // 两次调用，第一次转换为commonjs代码，第二次转换为异步代码
    // 异步代码使用异步函数包裹，并通过传入resolve、reject函数来回传模块导出
    code = transformCode(
      `(async (resolve, reject) => {\n${transformCode(
        originalCode
      )}\n\n})(void 0, void 0).then(() => resolve(module), reject)`,
      // 第二次调用transformCode时使用异步转换插件，将require、__webpack_require__方法转换为异步调用
      // 这里需要转为异步的原因是，webpack转换资源模块是异步的（通过loader链来转换）
      getTransformPlugin(loaderContext, webpackModule.module)
    )
    codeCache.set(hash, code)
  }
  // 创建模块上下文
  const vmContext = vm.createContext(webpackModule)
  // 运行虚拟机
  vm.runInContext(code, vmContext, {
    displayErrors: true,
    breakOnSigint: true,
  })
}

// 存储publicPath值
function setPublicPath(loaderContext: LoaderContext, publicPath: PublicPath) {
  const { data } = loaderContext
  Object.defineProperty(data, publicPathSymbol, { value: publicPath })
}

// 获取publicPath值
function getPublicPath(loaderContext: LoaderContext) {
  const { data } = loaderContext
  return Reflect.get(data, publicPathSymbol)
}

// 清理缓存与浏览器虚拟环境
function clear(loaderContext: LoaderContext) {
  getModuleCache(loaderContext).clear()
  try {
    if (BrowserWindow) {
      BrowserWindow.close()
      BrowserWindow = null
    }
  } catch (e) {}
}

// 获取模块缓存的容器
function getModuleCache(loaderContext: LoaderContext) {
  const { data } = loaderContext
  if (!hasOwnProperty(data, virtualModuleSymbol)) {
    Object.defineProperty(data, virtualModuleSymbol, {
      value: new Map<string, VirtualModule>(),
    })
  }
  return Reflect.get(data, virtualModuleSymbol) as Map<string, VirtualModule>
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

// 根据请求资源获取模块的ID
function getModuleIdFromRequest(loaderContext: LoaderContext, context: string, resource: string) {
  return new Promise<string>((resolve, reject) => {
    // 使用webpack的resolver来解析资源
    loaderContext.resolve(context, resource, (err, result) => (err ? reject(err) : resolve(result)))
  })
}

// 定义虚拟模块，如果传了第三个参数，则参数为es模块的默认导出值
function defineVirtualModule(loaderContext: LoaderContext, id: string, ...defaults: [] | [any]) {
  const module: VirtualModule =
    getModuleFromCache(loaderContext, id) ||
    Object.defineProperties(
      {
        loaded: false,
        promise: null,
        exports: Object.defineProperty({}, virtualModuleSymbol, { value: true }),
      },
      // 下面两个属性只读
      {
        id: { value: path.normalize(id || '') },
        parents: { value: new Set<VirtualModule>() },
      }
    )
  if (module.id) {
    getModuleCache(loaderContext).set(id, module)
  }
  if (defaults.length && !isEsModuleExport(module.exports)) {
    if (!hasOwnProperty(module.exports, virtualModuleSymbol)) {
      // 模块的导出被覆写了(module.exports = xxx 之类)
      // 这里重设下模块导出
      module.exports = Object.defineProperty({}, virtualModuleSymbol, { value: true })
    }
    // 声明默认导出，将其定义为一个es模块
    Object.defineProperties(module.exports, {
      __esModule: { value: true },
      default: { value: defaults[0] },
    })
  }
  return module
}

// 处理commonjs模块到es模块的转换
function getVirtualModuleResolve(
  loaderContext: LoaderContext,
  id: string,
  resolve: (value: any) => void
): VirtualModuleResolve {
  return (module: VirtualModule) => {
    const { exports } = module
    if (isEsModuleExport(exports)) {
      resolve(exports)
    } else {
      // commonjs模块导出，转换为es模块导出，后面返回模块时，再作统一commonjs模块转换处理
      resolve(defineVirtualModule(loaderContext, id, exports).exports)
    }
  }
}

// 确保reject的是一个异常对象
function getVirtualModuleReject(reject: (reason?: any) => void): VirtualModuleReject {
  return (reason?: any) => {
    if (reason instanceof Error) {
      reject(reason)
    } else if (typeof reason !== 'undefined') {
      reject(new Error(`${reason}`))
    } else {
      reject(new Error('Unknown Error'))
    }
  }
}

// 加载webpack模块
function loadWebpackModule(
  loaderContext: LoaderContext,
  request: string,
  resolve: VirtualModuleResolve,
  reject: VirtualModuleReject
) {
  loaderContext.loadModule(request, (err, source, sourceMap, module) => {
    if (err) {
      return reject(err)
    }
    // 这两个属性在文档上没有公开，但实际一直是存在于module上的
    // 去掉这两个属性也是可以，resource（也就是模块文件路径，当作ID）可以从函数参数传入
    // webpack一般只处理js代码，能到这里，非js代码的资源也都转换成了一个资源路径导出变量，所以还是一个js模块
    const { type, resource } = module as any
    if (!/javascript/i.test(type)) {
      return resolve(defineVirtualModule(loaderContext, resource, source))
    }
    try {
      // 继续运行模块代码
      evalModuleCode(
        loaderContext,
        source,
        createVirtualWebpackModule(loaderContext, resource, resolve, reject)
      )
    } catch (err) {
      reject(err)
    }
  })
}

// 检查循环依赖
function isCycleDependency(parentModule: VirtualModule, childModule: VirtualModule) {
  childModule.parents.add(parentModule)
  const parents = new Set<VirtualModule>()
  // 搜集所有父模块依赖
  const gather = (module: VirtualModule) => {
    parents.add(module)
    for (const parent of module.parents) {
      if (!parents.has(parent)) {
        gather(parent)
      }
    }
  }
  gather(parentModule)
  // 如果父模块依赖里面，包含当前模块，则是循环依赖
  return parents.has(childModule)
}

// 处理模块导出兼容
function resolveModuleExports(exports: VirtualModuleExports) {
  // 从虚拟模块过来的导出，都统一处理成es模块了的
  const defaultExport = exports.default
  if (hasOwnProperty(defaultExport, 'default')) {
    return defaultExport
  }
  // 如果虚拟机运行的模块期望是es模块环境，会取default属性
  // 有些模块代码本身没做兼容处理，这里我们用一个代理，捕获default属性访问，并返回实际的模块导出内容
  return new Proxy(defaultExport, {
    get(target, prop, receiver) {
      return prop === 'default' ? target : Reflect.get(target, prop, receiver)
    },
  })
}

// 异步require方法，用于桥接commonjs的require到webpack的loadModule
function getAsyncWebpackRequire(
  loaderContext: LoaderContext,
  context: string,
  parentModule: VirtualModule
): AsyncWebpackRequire {
  return async (request: string) => {
    const loadersAndResource = request.split('!')
    const resource = loadersAndResource.pop()!
    const id = await getModuleIdFromRequest(loaderContext, context, resource)
    const resourceRequest = `${loadersAndResource.join('!')}!${id}`
    const module = defineVirtualModule(loaderContext, id)

    if (isCycleDependency(parentModule, module)) {
      // 返回当前模块已经导出了的内容
      return resolveModuleExports(
        await new Promise((resolve) => {
          getVirtualModuleResolve(loaderContext, id, resolve)(module)
        })
      )
    }

    module.promise =
      module.promise ||
      new Promise((resolve, reject) =>
        loadWebpackModule(
          loaderContext,
          resourceRequest,
          getVirtualModuleResolve(loaderContext, id, resolve),
          getVirtualModuleReject(reject)
        )
      )

    // 等待模块完成加载
    const exports = await module.promise
    module.loaded = true
    return resolveModuleExports(exports)
  }
}

// 创建虚拟的webpack模块上下文对象
function createVirtualWebpackModule(
  loaderContext: LoaderContext,
  id: string,
  resolve: VirtualModuleResolve,
  reject: VirtualModuleReject
): VirtualWebpackModule {
  const module = defineVirtualModule(loaderContext, id)
  const context = path.dirname(id)
  const asyncWebpackRequire = getAsyncWebpackRequire(loaderContext, context, module)
  // 提供一个虚拟浏览器运行环境
  return Object.assign(Object.create(getBrowserWindow()), {
    resolve,
    reject,
    module,
    exports: module.exports,
    // webpack模块的上下文变量还有一些，一般用不到，但下面这三个，很有可能用到
    __webpack_public_path__: getPublicPath(loaderContext),
    __non_webpack_require__: require, // 这个require是commonjs模块系统里的同步加载，一般浏览器端的代码，用不到（electron环境等可以用到）
    __webpack_require__: asyncWebpackRequire,
    // 这里我们通过一个异步方法包裹，将模块内部的同步require通过babel的抽象语法树来转译成异步调用，以适配webpack模块的异步加载
    require: asyncWebpackRequire,
  })
}

/**
 * 使用虚拟机执行webpack模块，并返回模块的导出
 * 用于抽取css，只需要执行一些简单的代码就行了
 * 这里也支持复杂代码的运行
 * @param loaderContext loader上下文对象，就是loader函数里面的那个this
 * @param source loader处理的源代码
 * @param publicPath 引用资源的部署相对路径
 */
export default function exec(loaderContext: LoaderContext, source: string, publicPath: PublicPath) {
  const { resourcePath } = loaderContext
  setPublicPath(loaderContext, publicPath)
  //
  return new Promise((resolve: (value: any) => void, reject) =>
    evalModuleCode(
      loaderContext,
      source,
      createVirtualWebpackModule(
        loaderContext,
        resourcePath,
        getVirtualModuleResolve(loaderContext, resourcePath, resolve),
        getVirtualModuleReject(reject)
      )
    )
  )
    .then((exports: VirtualModuleExports) => {
      // 清理下
      clear(loaderContext)
      return resolveModuleExports(exports)
    })
    .catch((err) => {
      clear(loaderContext)
      throw err
    })
}
