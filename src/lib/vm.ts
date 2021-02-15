import vm from 'vm'
import * as path from 'path'
import * as babel from '@babel/core'
import { PluginItem } from '@babel/core'
import { toAsyncFunction, toCallExpression } from './asyncConverter'
import { hasOwnProperty, isEsModuleExport } from './utils'

const virtualModuleSymbol = Symbol('__virtualModule')
const publicPathSymbol = Symbol('__publicPath')

type LoaderContext = import('webpack').loader.LoaderContext
type PublicPath = string | ((file: string) => string)

type VirtualModuleExports = {
  readonly [virtualModuleSymbol]: symbol
  readonly __esModule?: boolean
  default?: any
  [p: string]: any
}

type VirtualModule = {
  readonly id: string
  exports: VirtualModuleExports
}

type AsyncWebpackRequire = (request: string) => Promise<VirtualModule>
type VirtualModuleResolve = (module: VirtualModule) => void
type VirtualModuleReject = (reason: Error) => void

interface BrowserModule {
  btoa(): string
  atob(): string
}

interface VirtualWebpackModule extends BrowserModule {
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

// 可能要用到的浏览器环境方法
// css-loader就用到了btoa来将sourceMap转换为base64格式并附加到样式文件里
function getBrowserModule() {
  return {
    // base64编码
    btoa(data: string) {
      return Buffer.from(data).toString('base64')
    },
    // base64解码
    atob(data: string): string {
      return new Buffer(data, 'base64').toString('utf8')
    },
  } as BrowserModule
}

// 编译转换代码
function transformCode(originalCode: string, plugins: PluginItem[] = []) {
  return (
    babel.transform(originalCode, {
      plugins,
      babelrc: false,
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

// 使用虚拟机编译运行模块代码
function evalModuleCode(
  loaderContext: LoaderContext,
  originalCode: string,
  webpackModule: VirtualWebpackModule
) {
  // 转换代码
  // 两次调用，第一次转换为commonjs代码，第二次转换为异步代码
  // 异步代码使用异步函数包裹，并通过传入resolve、reject函数来回传模块导出
  const code = transformCode(
    `(async (resolve, reject) => {\n${transformCode(
      originalCode
    )}\n\n})(void 0, void 0).then(() => resolve(module), reject)`,
    // 第二次调用transformCode时使用异步转换插件，将require、__webpack_require__方法转换为异步调用
    // 这里需要转为异步的原因是，webpack转换资源模块是异步的（通过loader链来转换）
    getTransformPlugin(loaderContext, webpackModule.module)
  )
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

// 清理缓存
function clearModuleCache(loaderContext: LoaderContext) {
  getModuleCache(loaderContext).clear()
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

// 根据请求地址获取模块的ID
function getModuleIdFromRequest(loaderContext: LoaderContext, context: string, request: string) {
  return new Promise<string>((resolve, reject) => {
    loaderContext.resolve(context, request, (err, result) => (err ? reject(err) : resolve(result)))
  })
}

// 定义虚拟模块，如果传了第三个参数，则参数为es模块的默认导出值
function defineVirtualModule(loaderContext: LoaderContext, id: string, ...defaults: [] | [any]) {
  const module: VirtualModule =
    getModuleFromCache(loaderContext, id) ||
    Object.defineProperties(
      // exports 可以覆写
      { exports: Object.defineProperty({}, virtualModuleSymbol, { value: true }) },
      {
        // id 只读
        id: { value: path.normalize(id || '') },
      }
    )
  if (module.id) {
    getModuleCache(loaderContext).set(id, module)
  }
  if (defaults.length && !isEsModuleExport(module.exports)) {
    if (!hasOwnProperty(module.exports, virtualModuleSymbol)) {
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
) {
  return ((module: VirtualModule) => {
    const { exports } = module
    if (isEsModuleExport(exports)) {
      // 已经是es模块导出
      resolve(exports)
    } else {
      // commonjs模块导出，转换为es模块导出
      resolve(defineVirtualModule(loaderContext, id, exports).exports)
    }
  }) as VirtualModuleResolve
}

// 确保reject的是一个异常对象
function getVirtualModuleReject(reject: (reason?: any) => void) {
  return ((reason?: any) => {
    if (reason instanceof Error) {
      reject(reason)
    } else if (typeof reason !== 'undefined') {
      reject(new Error(`${reason}`))
    } else {
      reject(new Error('Unknown Error'))
    }
  }) as VirtualModuleReject
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

// 异步require方法，用于桥接commonjs的require到webpack的loadModule
function getAsyncWebpackRequire(loaderContext: LoaderContext, context: string) {
  return (async (request: string) => {
    const id = await getModuleIdFromRequest(loaderContext, context, request)
    // 这里先从缓存模块中获取模块，避免重复的模块代码执行
    // 重复加载执行模块代码，除非是明确知道模块是函数式定义的，否则就不能重复加载
    // 重复执行代码，意味着模块内部的变量全部重新初始化，很多时候这些变量在一次运行期间只能初始化一次
    // 在这里的场景，一次运行指当前loader的一次运行周期，loader执行完虚拟机执行环境就可以释放掉了
    // 因为代码是直接从源码编译放虚拟机运行的，所以也不会进入到node的模块系统
    // 理论上虚拟机环境可以仿真出浏览器环境来运行webpack的模块代码
    const module = getModuleFromCache(loaderContext, id)
    if (module) {
      return module
    }
    return new Promise((resolve, reject) =>
      loadWebpackModule(
        loaderContext,
        request,
        getVirtualModuleResolve(loaderContext, id, resolve),
        getVirtualModuleReject(reject)
      )
    )
  }) as AsyncWebpackRequire
}

// 创建虚拟的webpack模块上下文对象
function createVirtualWebpackModule(
  loaderContext: LoaderContext,
  id: string,
  resolve: VirtualModuleResolve,
  reject: VirtualModuleReject
) {
  const module = defineVirtualModule(loaderContext, id)
  const context = path.dirname(id)
  const asyncWebpackRequire = getAsyncWebpackRequire(loaderContext, context)
  return {
    ...getBrowserModule(),
    resolve,
    reject,
    module,
    exports: module.exports,
    // webpack模块的上下文变量还有一些，一般用不到，但下面这三个，很有可能用到
    __webpack_public_path__: getPublicPath(loaderContext),
    __non_webpack_require__: require, // 这个require是commonjs模块系统里的同步加载，一般浏览器端的代码，用不到（electron环境等可以用到）
    __webpack_require__: asyncWebpackRequire,
    // 这个require方法不会由webpack来解析，因为是我们自己在虚拟出运行环境来执行webpack的模块代码
    // 以前webpack在loader上下文里提供了一个exec方法来执行模块代码，后来被移除掉了，不知道为啥就不提供了
    // 而且以前的exec方法的实现，简单粗暴直接调用node module的内部私有方法执行模块，也许存在较多问题
    // 另node较新版本，已经提供了更好的虚拟机来帮助快速运行一段动态生成的模块代码，估计这个应用场景有很大需求
    // 这里我们通过一个异步方法包裹，将模块内部的同步require通过babel的抽象语法树来转译成异步调用，以适配webpack模块的异步加载
    require: asyncWebpackRequire,
  } as VirtualWebpackModule
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
    .then((exports: VirtualModule['exports']) => {
      // 清理下模块缓存
      // 清不清其实无所谓，loaderContext在执行完loader，webpack就会释放掉，所以也不会有内存泄露
      // 这里清理下，以防止可能出现的loaderContext未被释放的情况（不大可能）
      clearModuleCache(loaderContext)
      // 转换为commonjs模块导出
      return isEsModuleExport(exports) ? exports.default : exports
    })
    .catch((err) => {
      clearModuleCache(loaderContext)
      throw err
    })
}
