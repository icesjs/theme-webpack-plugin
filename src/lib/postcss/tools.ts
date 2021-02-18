import { getHashDigest } from 'loader-utils'
import { AtRule, Declaration, Node, Plugin, Root, Rule, Syntax } from 'postcss'
import valueParser, {
  FunctionNode as FunctionValueNode,
  Node as ValueNode,
} from 'postcss-value-parser'
import { isColorValue } from '../colors'

export const pluginName = 'postcss-extract-theme-vars'

export interface ThemeVarsMessage {
  plugin: typeof pluginName // 当前插件的名称
  type:
    | 'theme-vars' // 当前解析上下文中的主题变量
    | 'theme-root-vars' // 当前解析上下文中的:root规则自定义属性变量
    | 'theme-context-vars' // 当前文件中声明的本地变量
    | 'theme-url-vars' // 导入文件中的url地址变量
    | 'theme-prop-vars' // 从属性值中分离出的主题变量引用

  ident: string // 属性名hash标识名
  originalName: string // 属性原始名称
  value: string // 变量解析后的值
  originalValue: string // 属性原始值
  isRootDecl: boolean // 是否是:root{}下的属性声明
  parsed: boolean // 是否已处理值解析
  dependencies?: VarsDependencies // 依赖的变量
  from?: string // 来源文件路径
  data?: any // 额外的数据
}

export type ThemePropertyMatcher = readonly [RegExp, RegExp, RegExp]

export interface VarsDictItem extends Omit<ThemeVarsMessage, 'type' | 'plugin'> {
  dependencies: VarsDependencies
}

export interface URLVarsDictItem extends VarsDictItem {
  data: Set<string>
  from: string
}

export type RefVarsDictItem = VarsDictItem

// ident => VarsDictItem
export type VarsDict = Map<string, VarsDictItem>
export type URLVarsDict = Map<string, URLVarsDictItem>
export type RefVarsDict = Map<string, RefVarsDictItem>

export interface ThemeLoaderData {
  urlMessages?: ThemeVarsMessage[]
  contextMessages?: ThemeVarsMessage[]
  variablesMessages?: ThemeVarsMessage[]
}

export interface PluginOptions extends ThemeLoaderData {
  syntax: string
  syntaxPlugin: Syntax
  onlyColor: boolean
}

export type ExtendPluginOptions<T> = ExtendType<PluginOptions, T>

export type ExtendType<S, T> = S & T

// ident =>  propName
export type VarsDependencies = Map<string, string>

type VariablesDecl = {
  ident: string
  value: string
  originalName: string
  originalValue: string
  isRootDecl: boolean
  dependencies: VarsDependencies
  decl: Declaration
  from: string | undefined
  parsed: boolean
}

// 这里的键是属性名（非ID）
type VariablesContext = Map<string, VariablesDecl>

export type VariablesContainer = {
  context: VarsDict
  variables: VarsDict
  urlVars: URLVarsDict
  references: RefVarsDict
}

type PluginContext<T> = ExtendType<T, { regExps: ThemePropertyMatcher; vars: VariablesContainer }>
type PluginCreator<T> = (context: PluginContext<T>) => Omit<Plugin, 'postcssPlugin'>

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

// 根据属性名称创建变量标识名
export function makeVariableIdent(name: string) {
  let ident = `--${name.replace(/[^-\w]/g, '') || 'var'}`
  ident += `-${getHashDigest(Buffer.from(name), 'md4', 'hex', 4)}`
  if (process.env.NODE_ENV !== 'development') {
    ident = `--${getHashDigest(Buffer.from(ident), 'md4', 'hex', 6)}`
  }
  return ident
}

// 判定一个值节点是否是主题相关的变量
export function determineCanExtractToRootDeclByIdent(
  ident: string,
  onlyColor: boolean,
  context: VarsDict,
  variables: VarsDict
) {
  if (context.has(ident) || !variables.has(ident)) {
    // 当前文件包含这个变量声明，则认为是本地变量，不作主题变量处理
    // 如果不是本地变量，也不是全局变量，则是个无效的变量引用
    return false
  }
  if (onlyColor) {
    // 这里的value是解析后的值
    const { value } = variables.get(ident)!
    // 节点是值解析的word类型，直接判断其值即可
    if (!value || !isColorValue(value)) {
      return false
    }
  }
  return true
}

// 根据变量的值来判定其是否能够被当成主题变量
export function determineCanUseAsThemeVarsByValue(value: string, onlyColor: boolean) {
  if (!value) {
    return false
  }
  if (onlyColor && !isColorValue(value)) {
    const parsed = valueParser(value)
    let hasColor = false
    // 可能是多值组合，比如：1px solid red
    // 对值进行解析处理，并逐一判定每个值
    parsed.walk((node) => {
      if (hasColor || node.type !== 'word' || (hasColor = isColorValue(node.value))) {
        // 返回false跳出迭代
        return false
      }
    }, true)

    if (!hasColor) {
      return false
    }
  }
  // 如果不仅仅是抽取颜色相关的变量值
  // 则所有的变量都当成主题变量对待
  return true
}

// 获取顶层变量
export function getTopScopeVariables(
  root: Root,
  regExps: ThemePropertyMatcher,
  filter?: null | ((decl: Declaration, isRootDecl: boolean) => boolean),
  normalize = true
) {
  const variables: VariablesContext = new Map()
  if (typeof filter !== 'function') {
    filter = () => true
  }
  for (const node of root.nodes) {
    if (node.type === 'decl' || node.type === 'atrule') {
      let decl
      if (node.type === 'atrule' && (node as any).variable) {
        // @var: value
        const value = (node as any).value || (node as AtRule).params || ''
        decl = {
          type: 'decl',
          prop: `@${node.name}`,
          value,
          source: node.source,
        }
      } else {
        // $var: value
        decl = node
      }
      const varNode = decl as Declaration
      if (regExps[1].test(varNode.prop) && filter(varNode, false)) {
        addTopScopeVariable(variables, varNode, root, false)
      }
    } else if (node.type === 'rule' && node.selector === ':root') {
      // :root {--prop: value}
      for (const rNode of node.nodes) {
        if (rNode.type === 'decl' && regExps[2].test(rNode.prop) && filter(rNode, true)) {
          addTopScopeVariable(variables, rNode, root, true)
        }
      }
    }
  }
  return normalize ? normalizeVarValue(variables, regExps) : variables
}

// 判断是不是顶层的属性声明
export function isTopRootDecl(decl: Declaration) {
  const { parent } = decl
  return parent?.type === 'rule' && (parent as Rule).selector === ':root'
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

// 将变量消息转换为变量字典
export function toVarsDict<T extends VarsDictItem>(
  messages: ThemeVarsMessage[] | null | undefined
): Map<string, T> {
  const vars = new Map<string, T>()
  if (!messages) {
    return vars
  }
  for (const { ident, type, plugin, dependencies = new Map(), ...rest } of messages) {
    vars.set(ident, {
      ...rest,
      ident,
      dependencies,
    } as T)
  }
  return vars
}

// 判断是否是一个URL函数调用节点
export function isURLFunctionNode(
  node: ValueNode,
  includeImageSet: boolean
): node is FunctionValueNode {
  if (node.type !== 'function') {
    return false
  }
  return node.value === 'url' || (includeImageSet && /(?:-webkit-)?image-set/.test(node.value))
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

// 获取引用类型变量
function getReferenceVars(contextDict: VarsDict, variablesDict: VarsDict) {
  const refs = new Map<string, RefVarsDictItem>()
  for (const { ident, dependencies, ...rest } of contextDict.values()) {
    // 如果本地变量的依赖变量全部来自主题变量，则认为该变量实际是对主题变量的间接引用
    if (
      dependencies?.size &&
      ![...dependencies.keys()].some((ident) => !variablesDict.has(ident))
    ) {
      refs.set(ident, { ident, dependencies, ...rest })
    }
  }
  return refs
}

// 添加顶层作用域变量到变量上下文
function addTopScopeVariable(
  variables: VariablesContext,
  varDecl: Declaration,
  root: Root,
  isRootDecl: boolean
) {
  variables.set(varDecl.prop, {
    ident: makeVariableIdent(varDecl.prop),
    dependencies: new Map<string, string>(),
    originalName: varDecl.prop,
    value: varDecl.value,
    originalValue: varDecl.value,
    isRootDecl,
    decl: varDecl,
    from: varDecl.source?.input.file || root.source?.input.file,
    parsed: false,
  } as VariablesDecl)
}

// 获取变量值
function getVarsValue(
  varName: string,
  varsDependency: VarsDependencies,
  variables: VariablesContext,
  regExps: ThemePropertyMatcher
) {
  if (!variables.has(varName)) {
    // 引用的变量不存在
    return ''
  }

  const { value } = variables.get(varName)!
  if (
    !value ||
    value === varName ||
    (regExps[0].test(value) && varsDependency.has(makeVariableIdent(value)))
  ) {
    // 空值，或则循环引用自身
    return ''
  }

  // 继续解析变量值（可能包含另外的变量）
  return parseValue(value, varsDependency, variables, regExps)
}

// 解析属性值
function parseValue(
  value: string,
  varsDependencies: VarsDependencies,
  variables: VariablesContext,
  regExps: ThemePropertyMatcher
) {
  if (!value) {
    return ''
  }

  let containVars = false
  const parsed = valueParser(value)
  parsed.walk((node) => {
    if (node.type === 'word' && regExps[0].test(node.value)) {
      // 当前节点是一个变量名引用
      containVars = true
      const varName = node.value
      varsDependencies.set(makeVariableIdent(varName), varName)
      node.value = getVarsValue(varName, varsDependencies, variables, regExps)
    }
  })

  return containVars ? valueParser.stringify(parsed.nodes) : value
}

// 格式化全局变量，解除变量引用关系
function normalizeVarValue(variables: VariablesContext, regExps: ThemePropertyMatcher) {
  for (const [prop, vars] of variables) {
    let { ident, value, originalName, dependencies } = vars
    dependencies.set(ident, originalName)
    value = value ? value.replace(/!(?!important).*/, '') : ''
    value = parseValue(value, dependencies, variables, regExps)
    if (!value) {
      variables.delete(prop)
    } else {
      dependencies.delete(ident)
      vars.value = value
      vars.parsed = true
    }
  }
  return variables
}

// 获取变量属性名称的正则表达式（@xxx、$xxx、--xxx）
function getVarPropertyRegExps(syntax: string) {
  const cssProp = String.raw`--[-\w]+`
  const regStr = [cssProp]
  if (/^s[ac]ss$/.test(syntax)) {
    regStr.push(String.raw`\$(?![\$\d])[-\$\w]+`)
  } else if (/^less$/.test(syntax)) {
    regStr.push(String.raw`@{1,2}(?!@)[-\w]+`)
  }
  const cssRegx = new RegExp(String.raw`^${cssProp}$`)
  const syntaxRegx = regStr[1] ? new RegExp(String.raw`^${regStr[1]}$`) : cssRegx
  const allRegx = regStr[1] ? new RegExp(String.raw`^(?:${regStr.join('|')})$`) : cssRegx
  return [allRegx, syntaxRegx, cssRegx] as ThemePropertyMatcher
}
