import isCssColor from 'is-color'

export const colorProperties = [
  'color',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-block',
  'border-block-color',
  'border-block-end',
  'border-block-end-color',
  'border-block-start',
  'border-block-start-color',
  'border-inline',
  'border-inline-color',
  'border-inline-end',
  'border-inline-end-color',
  'border-inline-start',
  'border-inline-start-color',
  'box-shadow',
  'caret-color',
  'column-rule',
  'column-rule-color',
  'outline',
  'outline-color',
  'scrollbar-color',
  'text-decoration',
  'text-decoration-color',
  'text-emphasis',
  'text-emphasis-color',
  'text-shadow',
  'fill',
]

export const colorPropertyRegex = new RegExp(`^(?:${colorProperties.join('|')})$`, 'i')

export function isColorName(name: string) {
  return typeof (name as any) === 'string'
    ? isCssColor.isKeyword(name) || isCssColor.isTransparent(name)
    : false
}

export function isColorValue(value: string) {
  return typeof (value as any) === 'string' ? isCssColor(value) : false
}

export function isColorProperty(prop: string) {
  return colorPropertyRegex.test(prop)
}
