import * as path from 'path'
import { Comment, Declaration, Helpers, Node, Rule } from 'postcss'
import {
  addSourceToNode,
  fixScssCustomizePropertyBug,
  insertRawBefore,
  setIndentedRawBefore,
} from './tools'
import { packageJson } from '../selfContext'
import { ChildNode } from 'postcss/lib/node'
import { ThemePropertyMatcher, VariablesContainer, VarsDict } from './variables'
import { isRootRuleSelector, isTopRootRule } from './assert'
import { getProcessedPropertyValue } from './process'

type CreateRuleOptions = {
  properties: VarsDict
  vars: VariablesContainer
  syntax: string
  regExps: ThemePropertyMatcher
  helper: Helpers
  isCopy: boolean // 是否是对属性的拷贝操作
  asComment?: boolean
}

// 创建自定义属性声明
export function insertVarsRootRule(options: CreateRuleOptions) {
  const { syntax, regExps, helper, asComment, isCopy } = options
  const { decls, deps } = createDeclarations(options, isCopy, 2)
  let node: Rule | Comment | null = null

  if (asComment) {
    if (!decls.length) {
      return
    }
    // 转换为注释节点（非主题文件），或者合并到:root声明（主题文件）
    node = toComment(createRootRule(decls, syntax, regExps, helper), helper)
    if (!node) {
      return
    }
  } else {
    // 写入 :root 节点，需要合并至已有的 :root 节点上
    // 不然 eslint 检查通不过
    node = mergeTopRootDecls(decls, !isCopy, options) as Rule
    if (!node.nodes.length) {
      return
    }
  }

  const root = helper.result.root
  let prevNode
  for (const node of root.nodes) {
    // 确定插入节点的位置，如果在依赖变量之前插入了节点，编译时会报变量未定义错误
    // 另外，要在@import url规则之后插入
    if (node.type === 'atrule') {
      if (node.name === 'import') {
        // @import 规则
        prevNode = node
      } else if ((node as any).variable && deps.has(`@${node.name}`)) {
        // @var 变量
        prevNode = node
      }
    } else if (node.type === 'decl' && regExps[1].test(node.prop) && deps.has(node.prop)) {
      // 引用了该变量
      prevNode = node
    }
  }

  if (prevNode) {
    root.insertAfter(prevNode, node)
  } else {
    root.prepend(node)
  }

  if (root.first !== node) {
    insertRawBefore(node, 2)
  }
  insertRawBefore(node.next(), 2)
  return node
}

// 创建:root规则对象
export function createRootRule(
  decls: Declaration[],
  syntax: string,
  regExps: ThemePropertyMatcher,
  helper: Helpers
) {
  const rootRule = helper.rule({
    // sass的bug，如果:root不用\:root转译，就会抛错
    selector: syntax === 'sass' ? String.raw`\:root` : `:root`,
    nodes: decls,
    raws: {
      between: ' ',
      after: decls.length ? '\n' : '',
      // 最后一条声明语句要以";"结尾，不然less等解析器会报错
      semicolon: /css|less|scss/.test(syntax),
    },
  })
  addSourceToNode(rootRule, helper.result?.root?.source)
  // 修复scss的bug
  rootRule.walkDecls(regExps[2], (decl) => {
    decl.value = fixScssCustomizePropertyBug(decl.value, syntax, regExps)
  })
  return rootRule
}

// 创建属性声明
export function createDeclarations(options: CreateRuleOptions, isCopy: boolean, indent = 0) {
  const { properties, vars, regExps, helper, asComment, syntax } = options
  const decls = []
  const propDeps: string[] = []

  for (const property of properties.values()) {
    const { ident, isRootDecl, originalName, value, originalValue, dependencies, source } = property
    const processedValue = getProcessedPropertyValue(property, vars, regExps, helper)
    const declValue =
      !isCopy && !isRootDecl
        ? processedValue === originalValue
          ? originalName
          : processedValue
        : processedValue

    propDeps.push(originalName, ...dependencies.values())
    const decl = helper.decl({
      prop: !isCopy ? ident : originalName,
      value: declValue,
      raws: {
        between: `: `,
        value: {
          value: declValue,
          raw: asComment ? value : declValue,
        },
      },
    })
    decl.source = source
    decls.push(decl)

    insertRawBefore(decl, 1)
    if (indent && /css|scss|less/.test(syntax)) {
      setIndentedRawBefore(decl, indent)
    }
  }

  return { decls, deps: new Set(propDeps) }
}

// 合并属性声明到:root中去
function mergeTopRootDecls(
  decls: Declaration[],
  clearCustomProps: boolean,
  options: CreateRuleOptions
) {
  const { regExps, syntax, helper } = options
  // 合并:root节点
  helper.result.root.each((node) => {
    if (isTopRootRule(node)) {
      const onlyRootSelector = !node.selectors.some((sel) => !isRootRuleSelector(sel))
      node.each((child) => {
        if (clearCustomProps && child.type === 'decl' && regExps[2].test(child.prop)) {
          // css标准自定义属性不合并到主题变量节点上去
          // 合并主题声明文件到样式文件时，已经把这部分变量移入样式文件中了
          return
        }
        const decl = onlyRootSelector ? child : child.clone()
        decls.push(decl as Declaration)
      })
      if (onlyRootSelector) {
        node.remove()
      } else {
        node.selectors = node.selectors.filter((sel) => !isRootRuleSelector(sel))
      }
    }
  })
  return createRootRule(decls, syntax, regExps, helper)
}

// 添加标题注释
export function addTitleComment(
  node: ChildNode | undefined | null,
  helper: Helpers,
  sourceFile?: string
) {
  if (node === undefined) {
    return
  }
  if (process.env.THEME_VARS_IDENT_MODE !== 'development') {
    if (node) {
      insertRawBefore(node, 2)
    }
    return
  }
  const { name, author } = packageJson
  const root = helper.result.root
  const email = author?.email ? `<${author!.email}>` : ''
  const divider = '=========================================================================='
  const waterMark = `Generated by ${name} ${email}`.padEnd(divider.length)
  const comment = helper.comment({
    text: `${sourceFile ? 'Variables From Theme File' : 'Theme Variables'} ${
      sourceFile ? `(${path.relative(process.cwd(), sourceFile)})` : ''
    }\n * ${divider} *\n * ${waterMark} *\n * ${divider}`,
    raws: { before: '\n', left: '*\n * ', right: ' ' },
  })
  addSourceToNode(comment, root.source)
  if (node) {
    root.insertBefore(node, comment)
    insertRawBefore(node, 2)
  } else {
    root.append(comment)
  }
  if (root.first !== comment) {
    insertRawBefore(comment, 2)
  }
}

// 转换节点为注释
function toComment(node: Node, helper: Helpers) {
  if (process.env.THEME_VARS_IDENT_MODE !== 'development') {
    return null
  }
  const comment = helper.comment({
    text: node
      .toString(helper.stringify)
      .split(/\r?\n/)
      .map(
        (line) =>
          ` * ${line.replace(
            /^(\s+)(.*)/,
            // 4空格缩进格式转换为2空格缩进
            (t, g1, g2) => ''.padEnd(2 * Math.floor(g1.length / 4) + (g1.length % 4)) + g2
          )}`
      )
      .join('\n'),
    raws: { left: '*\n', right: '\n ' },
  })
  addSourceToNode(comment, helper.result?.root?.source)
  return comment
}
