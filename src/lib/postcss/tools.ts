import { Helpers, Message, Node, Plugin, Root, Syntax } from 'postcss'
import valueParser, { Node as ValueNode } from 'postcss-value-parser'
import { isURLFunctionNode } from './assert'
import {
  getReferenceVars,
  getVarPropertyRegExps,
  makeVariableIdent,
  ThemePropertyMatcher,
  ThemeVarsMessage,
  toVarsDict,
  URLVarsDictItem,
  VariablesContainer,
  VarsDict,
} from './variables'

export const pluginName = 'postcss-extract-theme-vars'

export interface PluginMessages {
  urlMessages?: ThemeVarsMessage[]
  contextMessages?: ThemeVarsMessage[]
  variablesMessages?: ThemeVarsMessage[]
}

export interface PluginOptions extends PluginMessages {
  syntax: string
  syntaxPlugin: Syntax
  onlyColor: boolean
}

export type ExtendPluginOptions<T> = ExtendType<PluginOptions, T>

export type ExtendType<S, T> = S & T

type PluginContext<T> = ExtendType<T, { regExps: ThemePropertyMatcher; vars: VariablesContainer }>
type PluginCreator<T> = (context: PluginContext<T>) => Omit<Plugin, 'postcssPlugin'>

interface VarsMessageOptions extends Omit<ThemeVarsMessage, 'ident' | 'type' | 'plugin'> {
  helper: Helpers
  ident?: string
  type?: ThemeVarsMessage['type']
}

// 设置变量消息
export function setVarsMessage(options: VarsMessageOptions) {
  const {
    helper,
    originalName,
    type = 'theme-vars',
    ident = makeVariableIdent(originalName),
    ...rest
  } = options
  const msg = { ...rest, originalName, type, ident, plugin: pluginName } as ThemeVarsMessage
  delete (msg as any).decl
  const messages = helper.result.messages as ThemeVarsMessage[]
  const index = messages.findIndex(
    (msg) => msg.ident === ident && msg.type === type && msg.plugin === pluginName
  )
  if (index !== -1) {
    messages.splice(index, 1, msg)
  } else {
    messages.push(msg)
  }
  return msg
}

// 获取变量数据
export function getVarsMessages(
  messages: Message[],
  type: ThemeVarsMessage['type'] | ((msg: ThemeVarsMessage) => boolean) = 'theme-vars'
) {
  return messages.filter((msg) => {
    if (msg.plugin !== pluginName) {
      return false
    }
    if (typeof type === 'string') {
      return msg.type === type
    }
    if (typeof type === 'function') {
      return type(msg as ThemeVarsMessage)
    }
    return false
  }) as ThemeVarsMessage[]
}

// 辅助创建插件
export function pluginFactory<T extends PluginOptions>(options: T, createPlugin: PluginCreator<T>) {
  const { syntax, urlMessages, contextMessages, variablesMessages, ...rest } = options
  const contextDict = toVarsDict(contextMessages)
  const variablesDict = toVarsDict(variablesMessages)
  return {
    ...createPlugin({
      ...rest,
      syntax,
      regExps: getVarPropertyRegExps(syntax),
      vars: {
        context: contextDict,
        variables: variablesDict,
        urlVars: toVarsDict<URLVarsDictItem>(urlMessages),
        references: getReferenceVars(contextDict, variablesDict),
      },
    } as PluginContext<T>),
    postcssPlugin: pluginName,
  } as Plugin
}

// 修复scss对于:root节点自定义属性，不能正常使用变量引用的bug
export function fixScssCustomizePropertyBug(
  value: string,
  syntax: string,
  regExps: ThemePropertyMatcher
) {
  if (!/^s[ac]ss$/i.test(syntax)) {
    return value
  }
  // scss的bug，对:root规则下自定义属性的值，不会进行值替换
  // 除非使用 #{$var} 来引用变量
  const parsed = valueParser(value)
  let changed = false
  parsed.walk((node) => {
    if (node.type === 'word' && regExps[1].test(node.value)) {
      changed = true
      node.value = `#{${node.value}}`
    }
  })
  return changed ? valueParser.stringify(parsed.nodes) : value
}

// 解析属性声明值里的URL路径
export function parseURLPaths(value: string | ValueNode[], includeImageSet = true) {
  const paths: string[] = []

  if (typeof value === 'string' || Array.isArray(value)) {
    const nodes = typeof value === 'string' ? valueParser(value).nodes : value
    valueParser.walk(nodes, (node) => {
      if (!isURLFunctionNode(node, includeImageSet)) {
        return
      }
      if (node.value === 'url') {
        const { nodes } = node
        if (nodes.length !== 0 && nodes[0].type === 'string') {
          paths.push(nodes[0].value)
        } else {
          paths.push(valueParser.stringify(nodes))
        }
      } else {
        valueParser.walk(node.nodes, (child) => {
          if (child.type === 'string' && child.value) {
            paths.push(child.value)
          }
        })
      }
    })
  }

  return new Set(paths.filter((path) => path.trim()))
}

// 赋值raw before样式
export function insertRawBefore(node: Node | undefined, length = 1) {
  if (node?.raws) {
    const raws = node.raws
    let defaultType
    switch (node.type) {
      case 'atrule':
      case 'rule':
        defaultType = 'beforeRule'
        break
      case 'decl':
        defaultType = 'beforeDecl'
        break
      case 'comment':
        defaultType = 'beforeComment'
    }
    if (!raws.before) {
      delete raws.before
    }
    const before = (node.raw('before', defaultType) || '').replace(/(.|\r?\n)\1+/g, '$1')
    raws.before = before.padStart(length, before)
  }
  return node
}

// 添加缩进
export function setIndentedRawBefore(node: Node | undefined, indentLength = 2) {
  if (node?.raws) {
    const raws = node.raws
    let before = raws.before
    if (!before) {
      insertRawBefore(node, 1)
      before = raws.before || ''
    }
    const indent = ''.padEnd(
      Math.max(before.replace(/\r?\n/g, '').match(/^[\u0020]*/)![0].length, indentLength)
    )
    raws.before = before.replace(/[\u0020]/g, '') + indent
  }
  return node
}

// 获取当前处理的样式文件路径
export function getSourceFile(helper: Helpers, root: Root = helper.result.root) {
  return root.source?.input.file || helper.result.opts.from || ''
}

// 获取属性的所有依赖变量
export function getAllDependencies(ident: string, variables: VarsDict, context: VarsDict) {
  const varDeps = new Set<string>()
  let property = variables.get(ident) || context.get(ident)
  if (!property) {
    return varDeps
  }
  varDeps.add(ident)
  const { dependencies } = property
  if (!dependencies?.size) {
    return varDeps
  }
  for (const id of dependencies.keys()) {
    if (varDeps.has(id)) {
      continue
    }
    varDeps.add(id)
    for (const dep of getAllDependencies(id, variables, context)) {
      varDeps.add(dep)
    }
  }
  return varDeps
}
