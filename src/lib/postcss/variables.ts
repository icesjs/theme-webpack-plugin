import { AtRule, Declaration, Root, Source } from 'postcss'
import valueParser from 'postcss-value-parser'
import { getHashDigest } from 'loader-utils'
import { isTopRootRule } from './assert'

export interface ThemeVarsMessage {
  plugin: string // 当前插件的名称
  type:
    | 'theme-vars' // 当前解析上下文中的主题变量
    | 'theme-root-vars' // 当前解析上下文中的:root规则自定义属性变量
    | 'theme-context-vars' // 当前文件中声明的本地变量
    | 'theme-url-vars' // 导入文件中的url地址变量
    | 'theme-prop-vars' // 从属性值中分离出的主题变量引用
    | 'theme-custom-prop' // 不能作为主题变量的css自定义变量

  ident: string // 属性名hash标识名
  originalName: string // 属性原始名称
  value: string // 变量解析后的值
  originalValue: string // 属性原始值
  isRootDecl: boolean // 是否是:root{}下的属性声明
  parsed: boolean // 是否已处理值解析
  dependencies?: VarsDependencies // 依赖的变量
  source?: Source // 来源属性声明的source字段，用于sourceMap关联
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
  rawNode: Declaration | AtRule
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

// 根据属性名称创建变量标识名
export function makeVariableIdent(name: string) {
  let ident = `--${name.replace(/[^-\w]/g, '') || 'var'}`
  ident += `-${getHashDigest(Buffer.from(name), 'md4', 'hex', 4)}`
  if (process.env.THEME_VARS_IDENT_MODE !== 'development') {
    ident = `--${getHashDigest(Buffer.from(ident), 'md4', 'hex', 6)}`
  }
  // 如果--var变量第一个字符是个数字，sass解析器会抛错
  return ident.replace(/^--\d/, '--v')
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

// 获取引用类型变量
export function getReferenceVars(contextDict: VarsDict, variablesDict: VarsDict) {
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

// 获取变量属性名称的正则表达式（@xxx、$xxx、--xxx）
export function getVarPropertyRegExps(syntax: string) {
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

// 获取顶层变量
export function getTopScopeVariables(
  root: Root,
  regExps: ThemePropertyMatcher,
  filter?: null | ((decl: Declaration, isRootDecl: boolean) => boolean),
  normalize = true,
  persistRawNode = false
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
        addTopScopeVariable(variables, varNode, root, false, persistRawNode ? node : undefined)
      }
    } else if (isTopRootRule(node)) {
      // :root {--prop: value}
      for (const rNode of node.nodes) {
        if (rNode.type === 'decl' && regExps[2].test(rNode.prop) && filter(rNode, true)) {
          addTopScopeVariable(variables, rNode, root, true, persistRawNode ? rNode : undefined)
        }
      }
    }
  }
  return normalize ? normalizeVarValue(variables, regExps) : variables
}

// 添加顶层作用域变量到变量上下文
function addTopScopeVariable(
  variables: VariablesContext,
  varDecl: Declaration,
  root: Root,
  isRootDecl: boolean,
  rawNode?: Declaration | AtRule
) {
  variables.set(varDecl.prop, {
    ident: makeVariableIdent(varDecl.prop),
    dependencies: new Map<string, string>(),
    originalName: varDecl.prop,
    value: varDecl.value,
    originalValue: varDecl.value,
    isRootDecl,
    decl: varDecl,
    rawNode,
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
