import { getHashDigest } from 'loader-utils'
import { AtRule, Declaration, Plugin, Root, Rule, Syntax } from 'postcss'
import valueParser from 'postcss-value-parser'
import { isColorValue } from '../colors'

export const pluginName = 'postcss-extract-theme-vars'

export interface ThemeVarsMessage {
  plugin: typeof pluginName
  type: 'theme-vars' | 'theme-root-vars' | 'theme-context'
  ident: string
  originalName: string
  value: string
  originalValue: string
  dependencies?: Set<string> // 消息里依赖列表里的值是ident值
}

export type ThemePropertyMatcher = readonly [RegExp, RegExp, RegExp]

// name是原来的名称，
export type VarsDict = Map<
  string,
  {
    ident: string
    originalName: string
    value: string
    originalValue: string
    dependencies: Set<string>
    isTheme: boolean
  }
>

export interface ThemeLoaderData {
  themeMessages?: ThemeVarsMessage[]
  contextMessages?: ThemeVarsMessage[]
  variablesMessages?: ThemeVarsMessage[]
}

export interface ExtractVarsPluginOptions extends ThemeLoaderData {
  syntax: string
  syntaxPlugin: Syntax
  onlyColor: boolean
  parseValue?: boolean
  messages?: ThemeVarsMessage[]
}

export type RefVars = {
  ident: string
  originalName: string
  value: string
  originalValue: string
  dependencies: Set<string>
}

type VariablesContext = Map<
  string,
  {
    ident: string
    value: string
    originalName: string
    originalValue: string
    isRootDecl: boolean
    dependencies: Set<string>
  }
>

type VariablesContainer = {
  themeVars: VarsDict | null
  context: VarsDict | null
  variables: VarsDict | null
  references: Map<string, RefVars>
}

interface PluginContext extends ExtractVarsPluginOptions {
  regExps: ThemePropertyMatcher
  vars: VariablesContainer
}

// 辅助创建插件
export function pluginFactory(
  options: ExtractVarsPluginOptions,
  createPlugin: (context: PluginContext) => Omit<Plugin, 'postcssPlugin'>
) {
  const { syntax, onlyColor, themeMessages, contextMessages, variablesMessages, ...rest } = options
  const contextDict = toVarsDict(contextMessages || null, false)
  const variablesDict = toVarsDict(variablesMessages || null, false)
  return {
    ...createPlugin({
      ...rest,
      syntax,
      regExps: getVarPropertyRegExps(syntax),
      onlyColor: Boolean(onlyColor),
      vars: {
        context: contextDict,
        variables: variablesDict,
        themeVars: toVarsDict(themeMessages || null, true),
        references: getReferenceVars(contextDict, variablesDict),
      },
    }),
    postcssPlugin: pluginName,
  } as Plugin
}

// 根据属性名称创建变量标识名
export function makeVariableIdent(name: string) {
  let ident = `--${name.replace(/[^-\w\u4e00-\u9fa5]/g, '') || 'var'}`
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
        }
      } else {
        // $var: value
        decl = node
      }
      const varNode = decl as Declaration
      if (regExps[1].test(varNode.prop) && filter(varNode, false)) {
        const dependencies = new Set<string>()
        variables.set(varNode.prop, {
          ident: makeVariableIdent(varNode.prop),
          originalName: varNode.prop,
          value: varNode.value,
          originalValue: varNode.value,
          isRootDecl: false,
          dependencies,
        })
      }
    } else if (node.type === 'rule' && node.selector === ':root') {
      // :root {--prop: value}
      for (const rNode of node.nodes) {
        if (rNode.type === 'decl' && regExps[2].test(rNode.prop) && filter(rNode, true)) {
          const dependencies = new Set<string>()
          variables.set(rNode.prop, {
            ident: makeVariableIdent(rNode.prop),
            originalName: rNode.prop,
            value: rNode.value,
            originalValue: rNode.value,
            isRootDecl: true,
            dependencies,
          })
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
export function toVarsDict(messages: ThemeVarsMessage[] | null, isTheme: boolean) {
  if (!messages) {
    return null
  }
  const vars: VarsDict = new Map<
    string,
    {
      ident: string
      originalName: string
      value: string
      originalValue: string
      dependencies: Set<string>
      isTheme: boolean
    }
  >()
  for (const { ident, type, plugin, dependencies = new Set<string>(), ...rest } of messages) {
    vars.set(ident, {
      ...rest,
      ident,
      dependencies,
      isTheme,
    })
  }
  return vars
}

// 获取引用类型变量
function getReferenceVars(contextDict: VarsDict | null, variablesDict: VarsDict | null) {
  const refs = new Map<string, RefVars>()
  if (contextDict && variablesDict) {
    for (const [ident, { dependencies, ...rest }] of contextDict) {
      // 如果本地变量的依赖变量全部来自主题变量，则认为该变量实际是对主题变量的间接引用
      if (dependencies.size && ![...dependencies].some((deps) => !variablesDict.has(deps))) {
        refs.set(ident, { dependencies, ...rest })
      }
    }
  }
  return refs
}

// 获取变量值
function getVarsValue(
  varName: string,
  varsDependency: Set<string>,
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
  varsDependencies: Set<string>,
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
      varsDependencies.add(makeVariableIdent(varName))
      node.value = getVarsValue(varName, varsDependencies, variables, regExps)
    }
  })

  return containVars ? valueParser.stringify(parsed.nodes) : value
}

// 格式化全局变量，解除变量引用关系
function normalizeVarValue(variables: VariablesContext, regExps: ThemePropertyMatcher) {
  for (const [prop, vars] of variables) {
    let { ident, value, dependencies } = vars
    dependencies.add(ident)
    value = value ? value.replace(/!(?!important).*/, '') : ''
    value = parseValue(value, dependencies, variables, regExps)
    if (!value) {
      variables.delete(prop)
    } else {
      dependencies.delete(ident)
      vars.value = value
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
