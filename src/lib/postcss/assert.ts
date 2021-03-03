import isCssColor from 'is-color'
import { AtRule, ChildNode, Container, Declaration, Node, Rule } from 'postcss'
import { FunctionNode as FunctionValueNode, Node as ValueNode } from 'postcss-value-parser'

const implicitlyColorProperty = [
  'color',
  'background',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-block',
  'border-block-end',
  'border-block-start',
  'border-inline',
  'border-inline-end',
  'border-inline-start',
  'box-shadow',
  'column-rule',
  'outline',
  'text-decoration',
  'text-emphasis',
  'text-shadow',
  'fill',
]

const implicitlyColorPropertyRegex = new RegExp(`^(?:${implicitlyColorProperty.join('|')})$`, 'i')

const imageUrlRegex = /url\(\s*(['"]?)[^'"\s]+?\1\s*\)|(?:-webkit-)?image-set\(/

export function isColorValue(value: string) {
  if (typeof (value as any) !== 'string') {
    return false
  }
  if (isCssColor(value)) {
    return true
  }
  return imageUrlRegex.test(value)
}

export function isColorProperty(prop: string) {
  return implicitlyColorPropertyRegex.test(prop) || /-(?:color|image)$/.test(prop)
}

// 判断是不是一个顶层作用域变量属性声明
export function isTopScopeVariable<T extends Declaration | AtRule>(
  node: ChildNode,
  syntaxRegx: RegExp,
  cssRegx: RegExp
): node is T {
  if (node.parent?.type === 'root') {
    return isVariable(node, syntaxRegx)
  } else if (node.type === 'decl' && isTopRootDecl(node)) {
    return cssRegx.test(node.prop)
  }
  return false
}

// 判断节点是不是一个变量属性声明
export function isVariable(node: ChildNode, varRegx: RegExp): node is Declaration | AtRule {
  if ((node as Declaration).variable) {
    if (node.type === 'decl') {
      return varRegx.test(node.prop)
    }
    if (node.type === 'atrule') {
      return varRegx.test(`@${node.name}`)
    }
  }
  return false
}

// 判断节点是否是容器节点
export function isContainerNode(node: Node): node is Container {
  return typeof (node as any).each === 'function'
}

// 判断是不是顶层的纯粹:root规则
export function isTopRootRule(node: Node): node is Rule {
  if (node?.parent?.type === 'root' && node.type === 'rule') {
    const { selectors, selector } = node as Rule
    if (Array.isArray(selectors)) {
      return selectors.some(isRootRuleSelector)
    }
    return isRootRuleSelector(selector)
  }
  return false
}

// 判断是不是纯粹的:root规则选择器
export function isRootRuleSelector(selector: string) {
  // \:root 是兼容sass怪癖，没有反斜杠sass处理不了:root
  return /^(?:html|\\?:root)$/i.test(selector)
}

// 选择器是否能够选择中html元素
export function canSelectRootElement(selector: string) {
  // \:root 是兼容sass怪癖，没有反斜杠sass处理不了:root
  return /^(\[[^\]]*])*(?:html|\\?:root)(?=\[[^\]]*]|[:,.>~+\u0020]|$)/i.test(selector)
}

// 判断是不是顶层的属性声明
export function isTopRootDecl(decl: Declaration) {
  const { parent } = decl
  return parent?.type === 'rule' && isTopRootRule(parent)
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

export function hasResourceURL(value: string) {
  return imageUrlRegex.test(value)
}
