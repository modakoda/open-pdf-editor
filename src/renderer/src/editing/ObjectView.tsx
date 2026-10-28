/** Rendering of a single EditObject inside a page-space layer (positions are points × scale). */
import { memo, useMemo, type CSSProperties } from 'react'
import { StickyNote } from 'lucide-react'
import { arrowHead, type EditObject, type ImageObject, type InkObject, type LineObject, type NoteObject, type PageEntry, type TextObject } from '@core'
import { useImageUrl } from './images'
import { NOTE_SIZE } from './objects'
import { fontStack, safeLayout } from './textLayout'

export interface ObjectViewProps {
  obj: EditObject
  page: Pick<PageEntry, 'width' | 'height'>
  scale: number
  selected: boolean
  /** Hide the text glyphs (while the inline editor is open). */
  editing?: boolean
  /** Non-interactive preview (gesture in progress). */
  ghost?: boolean
  /** Displayed page rotation; sticky-note icons stay upright like in PDF viewers (NoRotate). */
  pageRotation?: number
}

function boxStyle(obj: { x: number; y: number; width: number; height: number; rotation?: number }, scale: number): CSSProperties {
  return {
    left: obj.x * scale,
    top: obj.y * scale,
    width: Math.max(obj.width, 0) * scale,
    height: Math.max(obj.height, 0) * scale,
    transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined
  }
}

function attrs(obj: EditObject, selected: boolean, ghost?: boolean) {
  return ghost
    ? { 'data-ghost': 'true' }
    : {
        'data-testid': 'object',
        'data-object-id': obj.id,
        'data-object-type': obj.type,
        'data-selected': selected ? 'true' : 'false'
      }
}

function TextView({ obj, scale, selected, editing, ghost }: ObjectViewProps & { obj: TextObject }) {
  const layout = useMemo(
    () => safeLayout(obj),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [obj.text, obj.font, obj.bold, obj.italic, obj.fontSize, obj.lineHeight, obj.width, obj.align]
  )
  const family = fontStack(obj.font, layout.unicode)
  const h = Math.max(obj.height, 1)
  const w = Math.max(obj.width, 1)
  return (
    <div
      className="ed-object ed-box"
      {...attrs(obj, selected, ghost)}
      style={{ ...boxStyle(obj, scale), opacity: obj.opacity ?? 1 }}
    >
      <svg className="ed-svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" overflow="visible">
        {obj.background ? <rect x={0} y={0} width={w} height={h} fill={obj.background} /> : null}
        {!editing && (
          <text
            fontFamily={family}
            fontSize={obj.fontSize}
            fontWeight={obj.bold ? 700 : 400}
            fontStyle={obj.italic ? 'italic' : 'normal'}
            fill={obj.color}
            dominantBaseline="alphabetic"
            style={{ whiteSpace: 'pre', fontKerning: 'none' }}
          >
            {layout.lines.map((line, i) => (
              <tspan
                key={i}
                x={line.x}
                y={line.baseline}
                {...(line.width > 0 && line.text.trim().length > 1 && !layout.unicode
                  ? { textLength: line.width, lengthAdjust: 'spacing' }
                  : {})}
              >
                {line.text}
              </tspan>
            ))}
          </text>
        )}
      </svg>
    </div>
  )
}

function ImageView({ obj, scale, selected, ghost }: ObjectViewProps & { obj: ImageObject }) {
  const url = useImageUrl(obj.data, obj.mimeType)
  return (
    <div className="ed-object ed-box" {...attrs(obj, selected, ghost)} style={{ ...boxStyle(obj, scale), opacity: obj.opacity ?? 1 }}>
      <img className="ed-image" src={url} alt="" draggable={false} />
    </div>
  )
}

function LineView({ obj, page, scale, selected, ghost }: ObjectViewProps & { obj: LineObject }) {
  const head = obj.arrowEnd ? arrowHead(obj) : null
  const end = head ? head.base : { x: obj.x2, y: obj.y2 }
  const hit = Math.max(obj.strokeWidth, 10 / scale)
  return (
    <svg
      className="ed-object ed-fullpage"
      {...attrs(obj, selected, ghost)}
      width={page.width * scale}
      height={page.height * scale}
      viewBox={`0 0 ${page.width} ${page.height}`}
      overflow="visible"
      style={{ opacity: obj.opacity ?? 1 }}
    >
      <line
        x1={obj.x1}
        y1={obj.y1}
        x2={end.x}
        y2={end.y}
        stroke={obj.color}
        strokeWidth={obj.strokeWidth}
        strokeLinecap="butt"
      />
      {head && <polygon points={[head.tip, head.left, head.right].map((p) => `${p.x},${p.y}`).join(' ')} fill={obj.color} />}
      <line className="ed-hit" x1={obj.x1} y1={obj.y1} x2={obj.x2} y2={obj.y2} strokeWidth={hit} stroke="transparent" strokeLinecap="round" />
    </svg>
  )
}

export function inkPathD(points: { x: number; y: number }[]): string {
  if (!points.length) return ''
  const [first, ...rest] = points
  return `M${first.x} ${first.y}` + (rest.length ? rest.map((p) => `L${p.x} ${p.y}`).join('') : `L${first.x} ${first.y}`)
}

function InkView({ obj, page, scale, selected, ghost }: ObjectViewProps & { obj: InkObject }) {
  const hit = Math.max(obj.strokeWidth, 10 / scale)
  return (
    <svg
      className="ed-object ed-fullpage"
      {...attrs(obj, selected, ghost)}
      width={page.width * scale}
      height={page.height * scale}
      viewBox={`0 0 ${page.width} ${page.height}`}
      overflow="visible"
      style={{ opacity: obj.opacity ?? 1 }}
    >
      {obj.paths.map((path, i) => (
        <g key={i}>
          <path
            d={inkPathD(path)}
            fill="none"
            stroke={obj.color}
            strokeWidth={obj.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path className="ed-hit" d={inkPathD(path)} fill="none" stroke="transparent" strokeWidth={hit} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}
    </svg>
  )
}

function NoteView({ obj, scale, selected, ghost, pageRotation }: ObjectViewProps & { obj: NoteObject }) {
  const size = NOTE_SIZE * scale
  return (
    <div
      className="ed-object ed-note"
      {...attrs(obj, selected, ghost)}
      title={obj.text ? `${obj.author ? obj.author + ': ' : ''}${obj.text}` : 'Sticky note'}
      style={{
        left: obj.x * scale,
        top: obj.y * scale,
        width: size,
        height: size,
        background: obj.color,
        opacity: obj.opacity ?? 1,
        transform: pageRotation ? `rotate(${-pageRotation}deg)` : undefined
      }}
    >
      <StickyNote size={size * 0.7} strokeWidth={2} aria-hidden="true" />
    </div>
  )
}

export const ObjectView = memo(function ObjectView(props: ObjectViewProps) {
  const { obj, scale, selected, ghost } = props
  switch (obj.type) {
    case 'text':
      return <TextView {...props} obj={obj} />
    case 'image':
      return <ImageView {...props} obj={obj} />
    case 'line':
      return <LineView {...props} obj={obj} />
    case 'ink':
      return <InkView {...props} obj={obj} />
    case 'note':
      return <NoteView {...props} obj={obj} />
    case 'rect':
    case 'ellipse': {
      const w = Math.max(obj.width, 0.01)
      const h = Math.max(obj.height, 0.01)
      const sw = obj.strokeColor ? obj.strokeWidth : 0
      return (
        <div className="ed-object ed-box" {...attrs(obj, selected, ghost)} style={{ ...boxStyle(obj, scale), opacity: obj.opacity ?? 1 }}>
          <svg className="ed-svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" overflow="visible">
            {obj.type === 'rect' ? (
              <rect x={0} y={0} width={w} height={h} fill={obj.fillColor ?? 'none'} stroke={obj.strokeColor ?? 'none'} strokeWidth={sw} />
            ) : (
              <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={obj.fillColor ?? 'none'} stroke={obj.strokeColor ?? 'none'} strokeWidth={sw} />
            )}
          </svg>
        </div>
      )
    }
    case 'highlight':
    case 'whiteout':
      return (
        <div
          className={`ed-object ed-box ed-${obj.type}`}
          {...attrs(obj, selected, ghost)}
          style={{
            ...boxStyle(obj, scale),
            background: obj.color,
            opacity: obj.opacity ?? (obj.type === 'highlight' ? 0.4 : 1)
          }}
        />
      )
  }
})
