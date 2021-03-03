import {
  ChildNode,
  Comment,
  Declaration,
  Helpers,
  Message,
  Node,
  Plugin,
  Position,
  Root,
  Rule,
  Source,
  Syntax,
} from 'postcss'
import valueParser, { Node as ValueNode } from 'postcss-value-parser'
import { isContainerNode, isURLFunctionNode, isVariable } from './assert'
import {
  getReferenceVars,
  getVarPropertyRegExps,
  makeVariableIdent,
  ThemePropertyMatcher,
  ThemeVarsMessage,
  toVariableDecl,
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
  decl: Declaration | undefined
  helper: Helpers
  ident?: string
  type?: ThemeVarsMessage['type']
}

// 设置变量消息
export function setVarsMessage(options: VarsMessageOptions) {
  const {
    decl,
    helper,
    originalName,
    type = 'theme-vars',
    ident = makeVariableIdent(originalName),
    ...rest
  } = options
  //
  const msg = { ...rest, originalName, type, ident, plugin: pluginName } as ThemeVarsMessage
  if (decl) {
    msg.source = decl.source
  }
  //
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
        return false
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
    raws.before = before.padStart(length, before || '\n')
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

// 获取当前处理的样式文件路径
export function getSourceFile(helper: Helpers, root: Root = helper.result.root) {
  return root.source?.input.file || helper.result.opts.from || ''
}

// 为新建节点添加source属性，sourceMap相关
export function addSourceToNode(node: Comment | Rule, source?: Source) {
  if (source) {
    const newSource = (node.source = { ...source } as any)
    for (const pos of ['start', 'end']) {
      if (!newSource[pos]) {
        newSource[pos] = {
          offset: 0,
          line: 1,
          column: 1,
        } as Position
      }
    }
  }
}

// 合并当前Root上的所有顶层:root规则声明
export function mergeRootRule(root: Root, syntax: string, regExps: ThemePropertyMatcher) {
  let rule: Rule | undefined
  root.each((node) => {
    if (node.type === 'rule' && /\\?:root/.test(node.selector)) {
      if (!rule) {
        rule = node
      } else {
        node.each((child) => {
          rule!.append(child)
        })
        node.remove()
      }
    }
  })
  if (rule) {
    rule.each((node) => {
      if (node.type === 'decl') {
        node.value = fixScssCustomizePropertyBug(node.value, syntax, regExps)
      }
    })
  }
  return rule || null
}

// 去掉插值符号
// 只处理scss语法，因为在属性的值里面使用插值标记，仅scss支持
// less的插值只能用在属性名里面，或者url字符串里面
export function trimInterpolation(value: string, syntax: string) {
  if (!/^(?:s[ac]ss)$/.test(syntax) || !/#{.+?}/.test(value)) {
    return value
  }
  // 处理scss的插值变量
  // 这里需要去掉插值变量标记，是因为 valueParser 处理的word类型值不会将插值标记去掉
  const startToken = '#{'
  const endToken = '}'
  const iterator = (nodes: ValueNode[]) => {
    let startIndex = -1
    let endIndex = -1
    nodes.forEach((node, index) => {
      const { value, type } = node
      if (type !== 'word') {
        if (node.type === 'function') {
          // 递归函数节点的子节点
          iterator(node.nodes)
        }
        return
      }
      // 处理标识符
      if (value.startsWith(startToken) && value.endsWith(endToken)) {
        // 没有多余空格的值
        node.value = value.substring(startToken.length, value.length - endToken.length)
      } else {
        // 记录并处理含多余空格的值
        if (value === startToken) {
          startIndex = index
        } else if (value === endToken) {
          endIndex = index
        }
        if (startIndex > -1 && endIndex > -1) {
          nodes[startIndex].value = ''
          nodes[endIndex].value = ''
          startIndex = endIndex = -1
        }
      }
    })
  }
  //
  const parsed = valueParser(value)
  iterator(parsed.nodes)
  //
  return valueParser.stringify(parsed.nodes)
}

// 迭代访问规则声明，过滤了@function节点
// 迭代的节点包含变量声明
export function walkDecls(
  root: Root,
  regExps: ThemePropertyMatcher,
  callback: (node: Declaration, index: number) => false | void
) {
  const excludeRuleRegx = /^(?:function)$/i
  const iterator = (child: ChildNode, index: number) => {
    if (child.type === 'atrule') {
      if (regExps[1].test('$x') && excludeRuleRegx.test(child.name)) {
        return
      }
    }

    // 执行回调
    let result
    const isVars = isVariable(child, regExps[0])
    if (isVars || child.type === 'decl') {
      try {
        const node = child as Declaration

        // 如果是个at规则的变量(less)，则转换为标准decl
        const decl = isVars ? toVariableDecl(node)! : node
        result = callback(decl, index)

        // at规则变量(less)的情况，如果decl更新了值，则更新原始节点的值
        if (isVars && child.type === 'atrule') {
          // @var: value
          if ((node.value || child.params) !== decl.value) {
            // 这里node和child指向的是同一个元素，只是代表的类型不同
            node.value = decl.value
            child.params = decl.value
          }
        }
      } catch (err) {
        const { addToError } = child as any
        if (typeof addToError === 'function') {
          throw addToError.call(child, err)
        }
        throw err
      }
    }

    // 迭代子节点
    if (result !== false && isContainerNode(child)) {
      result = child.each(iterator)
    }

    return result
  }

  if (isContainerNode(root)) {
    return root.each(iterator)
  }
}
