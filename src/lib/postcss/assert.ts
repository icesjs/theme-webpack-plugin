import isCssColor from 'is-color'
import { Declaration, Node, Rule } from 'postcss'
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

export const preservedAnimationIdentifier = /^(?:None|none|initial|inherit|linear|ease|ease-in|ease-out|ease-in-out|infinite|normal|reverse|alternate|alternate-reverse|running|paused|forwards|backwards|both)$/

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

// 判断是不是css动画保留的一些关键字
export function isPreservedAnimationIdentifier(value: string) {
  return preservedAnimationIdentifier.test(value)
}

export function hasResourceURL(value: string) {
  return imageUrlRegex.test(value)
}
