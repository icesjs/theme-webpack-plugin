import * as path from 'path'
import valueParser, { FunctionNode as FunctionValueNode } from 'postcss-value-parser'
import { Comment, Declaration, Helpers, Message, Node, Rule } from 'postcss'
import { isColorProperty } from '../colors'
import { selfModuleName } from '../selfContext'
import { isRelativePath, normalizeRelativePath } from '../utils'
import {
  determineCanExtractToRootDeclByIdent,
  fixScssCustomizePropertyBug,
  isTopRootDecl,
  isURLFunctionNode,
  makeVariableIdent,
  pluginName,
  RefVars,
  ThemePropertyMatcher,
  ThemeVarsMessage,
  URLVarsDict,
  URLVarsDictItem,
  VarsDependencies,
  VarsDict,
} from './tools'

type DeclValueProcessor = (value: string, isRootDecl: boolean) => string

type VariablesContainer = NonNullable<{
  context: VarsDict
  variables: VarsDict
  urlVars: URLVarsDict
  references: Map<string, RefVars>
}>

type PropertyLike = {
  ident: string
  value: string
  originalValue: string
  dependencies?: VarsDependencies
  urlDependencies?: Map<string, string>
}

type URLVariablesContainer = {
  context: VarsDict
  variables: VarsDict
  urlVars: URLVarsDict
}

interface VarsMessageOptions extends Omit<ThemeVarsMessage, 'ident' | 'type' | 'plugin'> {
  helper: Helpers
  ident?: string
  type?: ThemeVarsMessage['type']
}

type CreateRuleOptions = {
  properties: VarsDict
  vars: URLVariablesContainer
  syntax: string
  regExps: ThemePropertyMatcher
  helper: Helpers
  asComment?: boolean
}

// 设置变量消息
export function setVarsMessage(options: VarsMessageOptions) {
  const {
    originalName,
    type = 'theme-vars',
    ident = makeVariableIdent(originalName),
    helper,
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

// 获取变量抽取迭代处理函数。
// 消息 theme-vars。
export function getDeclProcessor(
  onlyColor: boolean,
  syntax: string,
  vars: VariablesContainer,
  regExps: ThemePropertyMatcher,
  helper: Helpers
) {
  // 值处理器
  const processor: DeclValueProcessor = getDeclValueProcessor(onlyColor, vars, regExps, helper)

  // 返回属性声明处理函数
  return (decl: Declaration) => {
    if (onlyColor && !regExps[2].test(decl.prop) && !isColorProperty(decl.prop)) {
      return
    }
    decl.value = processor(decl.value, isTopRootDecl(decl))
    if (regExps[2].test(decl.prop)) {
      decl.value = fixScssCustomizePropertyBug(decl.value, syntax, regExps)
    }
  }
}

// 添加标题注释
export function addTitleComment(node: Rule | Comment, helper: Helpers) {
  const root = helper.result.root
  const file = root.source?.input.file || ''
  const divider = '=========================================================================='
  const waterMark = `Generated by ${selfModuleName} <star2018@outlook.com>`.padEnd(divider.length)
  root.insertBefore(
    node,
    helper.comment({
      text: `Theme Variables ${
        file ? `(${path.relative(process.cwd(), file)})` : ''
      }\n * ${divider} *\n * ${waterMark} *\n * ${divider}`,
      raws: { before: '\n\n', left: '*\n * ', right: ' ' },
    })
  )
  //
}

// 创建自定义属性声明
export function createVarsRootRuleNode(options: CreateRuleOptions) {
  const { syntax, regExps, helper, asComment } = options
  const { decls, deps } = createDeclarations(options)
  const root = helper.result.root

  let node: Rule | Comment = createRootRule(decls, syntax, helper)

  // 确定插入节点的位置，如果在依赖变量之前插入了节点，编译时会报变量未定义错误
  // 另外，要在@import url规则之后插入
  let prevNode
  for (const node of root.nodes) {
    if (node.type === 'atrule' && node.name === 'import') {
      // @import 规则
      prevNode = node
    } else if (node.type === 'decl' && regExps[1].test(node.prop) && deps.has(node.prop)) {
      // 引用了该变量
      prevNode = node
    }
  }

  // 转换为注释节点（非主题文件），或者合并到:root声明（主题文件）
  if (asComment) {
    node = toComment(node, helper)
  } else {
    // 写入 :root 节点，需要合并至已有的 :root 节点上
    // 不然 eslint 检查通不过
    node = mergeTopRootDecls(node.nodes as Declaration[], regExps, syntax, helper)
  }

  if (prevNode) {
    root.insertAfter(prevNode, node)
  } else {
    root.prepend(node)
  }
  return node
}

// 修正属性声明中的外部资源引用地址
// 影响写入样式文件中的属性值
export function getProcessedPropertyValue(
  property: PropertyLike,
  vars: URLVariablesContainer,
  regExps: ThemePropertyMatcher,
  helper: Helpers
) {
  const { originalValue, ident } = property
  const { result } = helper
  const sourceFile = result.root.source?.input.file || result.opts.from
  if (!sourceFile) {
    return originalValue
  }

  const { urlVars, variables, context } = vars
  let { urlDependencies } = property
  if (!urlDependencies) {
    urlDependencies = property.urlDependencies = new Map<string, string>()
  }

  if (urlDependencies.has(sourceFile)) {
    return urlDependencies.get(sourceFile)!
  }

  const varDeps = getAllDependencies(ident, variables, context)
  const urlDeps = new Map<string, URLVarsDictItem>()
  for (const dep of varDeps) {
    if (urlVars.has(dep)) {
      urlDeps.set(dep, urlVars.get(dep)!)
    }
  }
  if (!urlDeps.size) {
    urlDependencies.set(sourceFile, originalValue)
    return originalValue
  }

  const processor = getURLValueProcessor({ sourceFile, urlDeps, variables, regExps, helper, vars })
  const processedValue = processor(originalValue)
  urlDependencies.set(sourceFile, processedValue)

  return processedValue
}

// 获取URL值处理器
function getURLValueProcessor(options: {
  sourceFile: string
  urlDeps: Map<string, URLVarsDictItem>
  variables: VarsDict
  regExps: ThemePropertyMatcher
  helper: Helpers
  vars: URLVariablesContainer
}) {
  const { sourceFile, urlDeps, variables, regExps, helper, vars } = options
  const context = path.dirname(sourceFile)
  return (originalValue: string) => {
    const parsed = valueParser(originalValue)
    let updated = false

    parsed.walk((node) => {
      if (isURLFunctionNode(node)) {
        // 是一个url或image-set函数调用
        for (const urlItem of urlDeps.values()) {
          if (updateURLFunctionValue(node, urlItem, context)) {
            updated = true
          }
        }
      } else if (node.type === 'word' && regExps[0].test(node.value)) {
        // 是一个变量引用
        const ident = makeVariableIdent(node.value)
        const varsItem = variables.get(ident)
        if (varsItem) {
          // 递归处理变量值
          const { originalValue } = varsItem
          const processedValue = getProcessedPropertyValue(varsItem, vars, regExps, helper)
          if (processedValue !== originalValue) {
            node.value = processedValue
            updated = true
          }
        }
      }
    })

    return updated ? valueParser.stringify(parsed.nodes) : originalValue
  }
}

// 更新url函数节点中的url值
function updateURLFunctionValue(
  node: FunctionValueNode,
  varsDict: URLVarsDictItem,
  context: string
) {
  const { data, from } = varsDict
  const relativeUrls = new Set([...data].filter((url) => isRelativePath(url)))
  if (!relativeUrls.size) {
    return false
  }
  const fromContext = path.dirname(from)
  let updated = false

  valueParser.walk(node.nodes, (child) => {
    const url = child.value
    // 这里有可能会出现匹配不到的情况，这是因为，对该变量的处理可能已经进行过了，再次进入处理是由其他变量引用当前变量导致的
    if (relativeUrls.has(url)) {
      // 转换路径到当前文件上下文
      const rewrittenUrl = normalizeRelativePath(
        path.relative(context, path.join(fromContext, url))
      )
      if (rewrittenUrl !== normalizeRelativePath(url)) {
        updated = true
        child.value = rewrittenUrl
      }
    }
  })

  return updated
}

// 获取属性的所有依赖变量
function getAllDependencies(ident: string, variables: VarsDict, context: VarsDict) {
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

// 创建:root规则对象
function createRootRule(decls: Declaration[], syntax: string, helper: Helpers) {
  return helper.rule({
    selector: ':root',
    nodes: decls,
    raws: {
      // 最后一条声明语句要以";"结尾，不然less等解析器会报错
      semicolon: /css|less|scss/.test(syntax),
    },
  })
}

// 创建属性声明对象
function createDeclarations(options: CreateRuleOptions) {
  const { properties, vars, regExps, helper, asComment } = options
  const decls = []
  const propDeps: string[] = []

  for (const property of properties.values()) {
    const { ident, value, dependencies } = property
    const declValue = getProcessedPropertyValue(property, vars, regExps, helper)

    propDeps.push(...dependencies.values())
    decls.push(
      helper.decl({
        prop: ident,
        value: declValue,
        raws: {
          between: `: `,
          value: {
            value: declValue,
            raw: asComment ? value : declValue,
          },
        },
      })
    )
  }

  return { decls, deps: new Set(propDeps) }
}

// 合并属性声明到:root中去
function mergeTopRootDecls(
  decls: Declaration[],
  regExps: ThemePropertyMatcher,
  syntax: string,
  helper: Helpers
) {
  const rootRule = createRootRule(decls, syntax, helper)
  // 合并:root节点
  for (const node of helper.result.root.nodes) {
    if (node.type === 'rule' && node.selector === ':root') {
      for (const child of node.nodes) {
        rootRule.append(child.clone())
      }
      node.remove()
    }
  }
  // 修复scss的bug
  rootRule.walkDecls(regExps[2], (decl) => {
    decl.value = fixScssCustomizePropertyBug(decl.value, syntax, regExps)
  })
  return rootRule
}

// 转换节点为注释
function toComment(node: Node, helper: Helpers) {
  return helper.comment({
    text: node
      .toString(helper.stringify)
      .split('\n')
      .map(
        (line) =>
          ` * ${line.replace(
            /^(\s+)(.*)/,
            // 4空格缩进格式转换为2空格缩进
            (t, g1, g2) => ''.padEnd(2 * Math.floor(g1.length / 4) + (g1 % 4)) + g2
          )}`
      )
      .join('\n'),
    raws: { before: '\n', left: '*\n *\n', right: '\n *\n ' },
  })
}

// 获取属性声明的值处理函数
// 修改被处理样式文件的主要方法
function getDeclValueProcessor(
  onlyColor: boolean,
  vars: VariablesContainer,
  regExps: ThemePropertyMatcher,
  helper: Helpers
) {
  const { context, variables, references } = vars
  const processor = (value: string, isRootDecl: boolean) => {
    if (!value) {
      return ''
    }

    let changed = false
    const parsed = valueParser(value)

    // 迭代值节点
    parsed.walk((node) => {
      // 非:root规则，不处理自定义属性变量（--var-name），因为css自定义属性可用从父级继承值，运行时不一定是全局变量值
      if (node.type === 'word' && regExps[isRootDecl ? 0 : 1].test(node.value)) {
        const varName = node.value
        const ident = makeVariableIdent(varName)
        const refVars = references.get(ident)
        if (refVars) {
          changed = true
          // 递归处理引用值
          node.value = processor(refVars.originalValue, isRootDecl)
          //
        } else if (determineCanExtractToRootDeclByIdent(ident, onlyColor, context, variables)) {
          //
          const originalValue = node.value
          const varItem = variables.get(ident)!
          const value = varItem.value || originalValue
          const dependencies = varItem.dependencies
          setVarsMessage({
            ident,
            originalName: varName,
            originalValue,
            isRootDecl,
            value,
            helper,
            type: 'theme-vars',
            parsed: true,
            dependencies,
          })

          // 处理URL地址
          const defaultValue = getProcessedPropertyValue(
            { ident, originalValue, value, dependencies },
            vars,
            regExps,
            helper
          )

          // 更新属性声明的值（修改原样式文件）
          node.value = `var(${ident}, ${defaultValue})`
          changed = true
        }
      }
    })
    // 修改声明值
    return changed ? valueParser.stringify(parsed.nodes) : value
  }
  //
  return processor
}
