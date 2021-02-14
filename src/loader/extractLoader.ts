import vm from 'vm'
import { format } from 'util'
import * as path from 'path'
import * as babel from '@babel/core'
import { PluginItem } from '@babel/core'
import { PluginLoader } from '../Plugin'
import asyncConverter from '../lib/asyncConverter'

type LoaderContext = import('webpack').loader.LoaderContext

type VirtualModuleExports = {
  readonly __virtualModule: symbol
  readonly __esModule?: boolean
  default?: any
  [p: string]: any
}

type VirtualModule = {
  id: string
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

// 对象上是否包含属性
function hasOwnProperty(obj: any, prop: PropertyKey, type?: string) {
  if (obj === null || obj === undefined) {
    return false
  }
  const hasProp = Object.prototype.hasOwnProperty.call(obj, prop)
  return hasProp && (type ? typeof obj[prop] === type : true)
}

// 判断模块导出是不是esModule格式
function isEsModuleExport(exports: VirtualModule['exports']) {
  return hasOwnProperty(exports, '__esModule', 'boolean')
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

// 使用虚拟机编译运行模块代码
function evalModuleCode(
  loaderContext: LoaderContext,
  originalCode: string,
  module: VirtualWebpackModule
) {
  // 转换代码
  // 两次调用，第一次转换为commonjs代码，第二次转换为异步代码
  const code = transformCode(
    `(async(resolve,reject)=>{\n${transformCode(
      originalCode
    )}\n\n})().then(()=>resolve(module),reject)`,
    // 第二次调用transformCode时使用异步转换插件，将require方法转换为异步调用
    [asyncConverter(['require', '__webpack_require__'])]
  )

  // 创建模块上下文
  const vmContext = vm.createContext(module)

  // 运行虚拟机
  vm.runInContext(code, vmContext, {
    displayErrors: true,
    breakOnSigint: true,
  })
}

// 定义虚拟模块，如果传了第二个参数，则参数为es模块的默认导出值
function defineVirtualModule(id: string, ...defaults: [] | [any]) {
  const module: VirtualModule = {
    id: path.normalize(id || ''),
    exports: Object.defineProperty({}, Symbol('__virtualModule'), { value: true }),
  }
  if (defaults.length) {
    // 声明默认导出，将其定义为一个es模块
    Object.defineProperties(module.exports, {
      __esModule: { value: true },
      default: { value: defaults[0] },
    })
  }
  return module
}

// 处理commonjs模块到es模块的转换
function getVirtualModuleResolve(id: string, resolve: (value: any) => void) {
  return ((module: VirtualModule) => {
    const { exports } = module
    if (isEsModuleExport(exports)) {
      // 已经是es模块导出
      resolve(exports)
    } else {
      // commonjs模块导出，转换为es模块导出
      resolve(defineVirtualModule(id, exports).exports)
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

// 异步require方法，用于桥接commonjs的require到webpack的loadModule
function getAsyncWebpackRequire(loaderContext: LoaderContext, publicPath: string) {
  return ((request: string) =>
    new Promise((resolve, reject) => {
      loaderContext.loadModule(request, (err, source, sourceMap, module) => {
        const moduleReject = getVirtualModuleReject(reject)
        if (err) {
          return moduleReject(err)
        }
        const { type, resource } = module as any
        const moduleResolve = getVirtualModuleResolve(resource, resolve)
        if (!/javascript/i.test(type)) {
          return moduleResolve(defineVirtualModule(resource, source))
        }
        try {
          // 继续运行模块代码
          evalModuleCode(
            loaderContext,
            source,
            createVirtualWebpackModule(
              loaderContext,
              resource,
              publicPath,
              moduleResolve,
              moduleReject
            )
          )
        } catch (err) {
          moduleReject(err)
        }
      })
    })) as AsyncWebpackRequire
}

// 创建虚拟的webpack模块上下文对象
function createVirtualWebpackModule(
  loaderContext: LoaderContext,
  id: string,
  publicPath: string,
  resolve: VirtualModuleResolve,
  reject: VirtualModuleReject
) {
  const module = defineVirtualModule(id)
  const webpackRequire = getAsyncWebpackRequire(loaderContext, publicPath)
  //
  return {
    ...getBrowserModule(),
    resolve,
    reject,
    module,
    exports: module.exports,
    __webpack_public_path__: publicPath,
    __non_webpack_require__: require,
    __webpack_require__: webpackRequire,
    require: webpackRequire,
  } as VirtualWebpackModule
}

// 执行模块，并返回模块执行导出
function exec(loaderContext: LoaderContext, source: string | Buffer, publicPath: string) {
  const { resourcePath } = loaderContext
  return new Promise((resolve: (value: any) => void, reject) => {
    evalModuleCode(
      loaderContext,
      Buffer.isBuffer(source) ? source.toString('utf8') : source,
      createVirtualWebpackModule(
        loaderContext,
        resourcePath,
        publicPath,
        getVirtualModuleResolve(resourcePath, resolve),
        getVirtualModuleReject(reject)
      )
    )
  }).then((exports: VirtualModule['exports']) => {
    // 将最终的值转换为commonjs导出
    return isEsModuleExport(exports) ? exports.default : exports
  })
}

// 获取资源内容
function getResourceContent(exports: any) {
  let css
  if (hasOwnProperty(exports, 'toString', 'function')) {
    css = exports.toString()
  } else if (Array.isArray(exports)) {
    css = exports[1] || ''
  }
  return typeof css === 'string' ? css : format(css)
}

// 获取资源发布路径，该路径对于css中资源引用(url(xxx))的路径很重要
function getPublicPath(loaderContext: LoaderContext) {
  //TODO: 还未完成
  const compilerOptions = extractLoader.getCompilerOptions!()
  const pluginOptions = extractLoader.getPluginOptions!()
  const { output } = compilerOptions
  const { publicPath } = pluginOptions
  let deployPath
  if (typeof publicPath === 'function') {
    deployPath = publicPath('', loaderContext.resourcePath, loaderContext.rootContext)
  } else if (typeof publicPath === 'string') {
    deployPath = publicPath
  }
  return deployPath || output.publicPath || './'
}

// normal阶段
const extractLoader: PluginLoader = function (source) {
  const callback = this.async() || (() => {})
  exec(this, source, getPublicPath(this))
    .then(getResourceContent)
    .then((content) => callback(null, content))
    .catch(callback)
}

extractLoader.filepath = __filename
export default extractLoader
