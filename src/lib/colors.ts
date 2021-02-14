import isCssColor from 'is-color'

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

export function isColorName(name: string) {
  return typeof (name as any) === 'string'
    ? isCssColor.isKeyword(name) || isCssColor.isTransparent(name)
    : false
}

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
