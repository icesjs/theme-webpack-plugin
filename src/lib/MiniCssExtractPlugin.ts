import type { Compiler } from 'webpack'
import type { PluginOptions as MiniCssPluginOptions } from 'mini-css-extract-plugin'
import MiniCssExtractPluginClass from 'mini-css-extract-plugin'
import * as fs from 'fs'
import * as path from 'path'
import * as semver from 'semver'
import { selfContext } from './selfContext'
import { getModuleFromCache, resolveModule } from './resolve'

type MiniCssExtractPluginClassType = typeof MiniCssExtractPluginClass

const pluginModuleName = 'mini-css-extract-plugin'
const UsedMiniCssExtractPlugin: MiniCssExtractPluginClassType = resolvePlugin()

function resolvePlugin() {
  const paths = new Set([
    selfContext,
    fs.realpathSync(process.cwd()),
    path.resolve('node_modules', 'react-scripts'),
    path.resolve('node_modules', '@vue/cli-service'),
  ])
  //
  const modules = [...paths]
    .map((context) => {
      try {
        return {
          module: resolveModule(pluginModuleName, [context]),
          version: resolveModule(`${pluginModuleName}/package.json`, [context]).version,
        }
      } catch (e) {}
    })
    .filter((item) => !!item)
    .sort((x, y) => (x === y ? 0 : semver.lt(x!.version, y!.version) ? -1 : 1))
  //
  const Plugin = modules.pop()
  if (!Plugin) {
    throw new Error(`Can not found '${pluginModuleName}' module`)
  }
  return Plugin.module as MiniCssExtractPluginClassType
}

/**
 * 合并配置项，并定义内部插件使用的配置
 * @param optsSet
 */
function mergeOptions(optsSet: Set<MiniCssPluginOptions>) {
  const options = {} as MiniCssPluginOptions
  for (let opts of optsSet) {
    const { attributes, ...rest } = Object.assign({}, opts)
    Object.assign(options, rest, {
      attributes: Object.assign({}, options.attributes, attributes),
    })
  }
  // insert 函数要做特殊处理，将主题样式与普通的样式分开
  const { insert: outerInsert } = options
  options.insert = function (linkTag: string) {
    // !!! 该函数要被序列化为字符串并添加到浏览器执行环境中去
    // !!! 使用 es5 的代码，不要调用任何 nodejs 的模块
    // !!! typescript 的类型标注可以使用
    debugger
    if (typeof outerInsert === 'string') {
    } else if (typeof outerInsert === 'function') {
    }
  }

  const validProperties = new Set<string>([
    'filename',
    'chunkFilename',
    'ignoreOrder',
    'insert',
    'attributes',
    'linkType',
  ])
  for (const prop of Object.keys(options)) {
    if (!validProperties.has(prop)) {
      delete (options as any)[prop]
    }
  }

  return options
}

function createPluginProxy(MiniCssExtractPlugin: MiniCssExtractPluginClassType) {
  const modules = getModuleFromCache(pluginModuleName)
  const innerOptionsSymbol = Symbol('CssExtractOptions')
  const instances = new WeakMap<Compiler, MiniCssExtractPluginClass>()
  const options = new WeakMap<Compiler, Set<MiniCssPluginOptions>>()

  // 拦截已注册的 mini-css-extract-plugin 的 apply，应用新版本插件，截取配置并进行修改
  for (const [, mod] of modules) {
    const { exports } = mod
    if (
      !exports ||
      typeof exports !== 'function' ||
      !Object.prototype.hasOwnProperty.call(exports, 'prototype')
    ) {
      continue
    }
    const prototype = exports.prototype
    if (!prototype || typeof prototype.apply !== 'function') {
      continue
    }
    //
    prototype.apply = new Proxy(prototype.apply, {
      apply(target, thisArg, [compiler]) {
        let inst = instances.get(compiler)
        //
        if (!inst) {
          if (!options.has(compiler)) {
            options.set(compiler, new Set<MiniCssPluginOptions>())
          }
          const opts = options.get(compiler)!
          if (thisArg.hasOwnProperty(innerOptionsSymbol)) {
            opts.add(Reflect.get(thisArg, innerOptionsSymbol))
            inst = new MiniCssExtractPlugin(mergeOptions(opts))
            opts.clear()
            instances.set(compiler, inst)
            return Reflect.apply(target, inst, [compiler])
          }
          //
          opts.add(thisArg.options)
        }
      },
    })
  }

  // 返回类的代理，theme-plugin 里面调用时拦截要使用的配置参数
  return new Proxy(MiniCssExtractPlugin, {
    construct(target, [options]: [MiniCssPluginOptions | undefined]) {
      const empty = new target() // 空实例，用于触发 apply 而已
      Object.defineProperty(empty, innerOptionsSymbol, {
        value: options,
      })
      return empty
    },
  })
}

let PluginConstructorProxy: MiniCssExtractPluginClassType

class MiniCssExtractPlugin {
  static loader = UsedMiniCssExtractPlugin.loader
  private readonly miniCssExtractPlugin: MiniCssExtractPluginClass

  constructor(options?: MiniCssPluginOptions) {
    if (!PluginConstructorProxy) {
      PluginConstructorProxy = createPluginProxy(UsedMiniCssExtractPlugin)
    }
    this.miniCssExtractPlugin = new PluginConstructorProxy(options)
  }

  apply(compiler: Compiler) {
    return this.miniCssExtractPlugin.apply(compiler)
  }
}

export default MiniCssExtractPlugin
