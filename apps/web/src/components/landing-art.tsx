import type { CSSProperties, ReactNode } from 'react'

// The front page's figures. Every colour and face is the Look's (fill and
// stroke classes over its tokens), so a deployment's figures wear its own
// palette and fonts. Motion lives in app.css (the lp- classes): each part
// says only when it joins its figure's loop.

/** A part joins its figure's loop this many seconds in. */
const at = (seconds: number): CSSProperties =>
  ({ '--lp-at': `${seconds}s` }) as CSSProperties

/** A dot that sets off at `seconds` and travels (dx, dy), turning at `turn`. */
const trip = (
  seconds: number,
  dx: number,
  dy: number,
  turn?: readonly [number, number],
): CSSProperties =>
  ({
    '--lp-at': `${seconds}s`,
    '--lp-dx': `${dx}px`,
    '--lp-dy': `${dy}px`,
    ...(turn === undefined
      ? {}
      : { '--lp-cx': `${turn[0]}px`, '--lp-cy': `${turn[1]}px` }),
  }) as CSSProperties

function Figure({
  label,
  width,
  height,
  children,
}: {
  label: string
  width: number
  height: number
  children: ReactNode
}) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className="lp-figure block h-auto w-full select-none"
    >
      {children}
    </svg>
  )
}

interface TextProps {
  x: number
  y: number
  /** Font size in the figure's units. */
  size?: number
  /** The fill class. */
  tone?: string
  /** The face: the Look's mono, body or display font. */
  face?: 'font-mono' | 'font-sans' | 'font-clash'
  end?: boolean
  middle?: boolean
  bold?: boolean
  /** The part's motion class, with `style` saying when it joins. */
  part?: string
  style?: CSSProperties
  children: ReactNode
}

function T({
  x,
  y,
  size = 10,
  tone = 'fill-neutral-300',
  face = 'font-mono',
  end,
  middle,
  bold,
  part,
  style,
  children,
}: TextProps) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fontWeight={bold ? 600 : undefined}
      textAnchor={end ? 'end' : middle ? 'middle' : undefined}
      className={`${face} ${tone} ${part ?? ''}`}
      style={style}
    >
      {children}
    </text>
  )
}

/** A window or terminal at the group's origin, with its title bar. */
function Frame({
  w,
  h,
  console,
  title,
  url,
}: {
  w: number
  h: number
  console?: boolean
  title?: string
  /** The address bar's text and where the bar starts. */
  url?: readonly [string, number]
}) {
  return (
    <>
      <rect
        width={w}
        height={h}
        rx={12}
        className={`lp-frame ${console ? 'lp-console' : 'lp-surface'}`}
      />
      <path d={`M0 24H${w}`} className="stroke-border" />
      {[13, 23, 33].map((cx) => (
        <circle
          key={cx}
          cx={cx}
          cy={12}
          r={2.75}
          className="fill-neutral-700"
        />
      ))}
      {title === undefined ? null : (
        <T x={w / 2} y={15.5} size={8.5} tone="fill-neutral-500" middle>
          {title}
        </T>
      )}
      {url === undefined ? null : (
        <>
          <rect
            x={url[1]}
            y={6}
            width={w - url[1] - 12}
            height={12}
            rx={6}
            className="fill-neutral-800/70"
          />
          <T x={url[1] + 9} y={14.8} size={8} tone="fill-neutral-400">
            {url[0]}
          </T>
        </>
      )}
    </>
  )
}

/** A shell prompt: the dollar sign in the brand colour. */
function Prompt({
  x,
  y,
  part = 'lp-type',
  when,
  children,
}: {
  x: number
  y: number
  part?: string
  when: number
  children: ReactNode
}) {
  return (
    <T
      x={x}
      y={y}
      size={9.5}
      tone="fill-neutral-100"
      part={part}
      style={at(when)}
    >
      <tspan className="fill-brand-300">$</tspan> {children}
    </T>
  )
}

/** A dot travelling a connector. */
function Packet({
  x,
  y,
  style,
}: {
  x: number
  y: number
  style: CSSProperties
}) {
  return (
    <circle
      cx={x}
      cy={y}
      r={3}
      className="lp-move fill-primary"
      style={style}
    />
  )
}

/** A row's brief highlight as something reaches it. */
function Flash({
  x,
  y,
  w,
  h,
  when,
}: {
  x: number
  y: number
  w: number
  h: number
  when: number
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={5}
      className="lp-flash fill-brand-300/15"
      style={at(when)}
    />
  )
}

function Check({
  x,
  y,
  tone = 'stroke-success-300',
}: {
  x: number
  y: number
  tone?: string
}) {
  return (
    <path
      d={`M${x} ${y}l2.6 2.6L${x + 7} ${y - 4}`}
      className={`fill-none ${tone}`}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
}

// ---------------------------------------------------------------------------
// The hero: push, compose, answer, read back
// ---------------------------------------------------------------------------

export function HeroFigure() {
  return (
    <Figure
      width={440}
      height={456}
      label="An agent pushes a folder. Its page takes the layout from the folder above, a person fills in the form and the answers are saved, and the agent reads them back."
    >
      {/* The page as a person opens it. */}
      <g transform="translate(110 60)">
        <Frame w={320} h={290} url={['agent964/acme/questions', 124]} />
        <g className="lp-in" style={at(1.3)}>
          <rect y={24} width={320} height={36} className="fill-brand-300/8" />
          <path d="M0 60H320" className="stroke-border" />
          <rect
            x={16}
            y={34}
            width={16}
            height={16}
            rx={4}
            className="fill-primary"
          />
          <T
            x={40}
            y={46.5}
            size={13}
            face="font-clash"
            tone="fill-neutral-50"
            bold
          >
            Acme
          </T>
          <T x={304} y={45.5} size={8.5} tone="fill-brand-200" end>
            _layout.html
          </T>
        </g>
        <Flash x={0} y={24} w={320} h={36} when={1.3} />
        <g className="lp-in" style={at(1.7)}>
          <T
            x={20}
            y={90}
            size={18}
            face="font-clash"
            tone="fill-neutral-50"
            bold
          >
            Delivery questions
          </T>
          <rect
            x={20}
            y={100}
            width={232}
            height={5}
            rx={2.5}
            className="fill-neutral-700"
          />
          <rect
            x={20}
            y={110}
            width={176}
            height={5}
            rx={2.5}
            className="fill-neutral-700"
          />
        </g>
        <g className="lp-in" style={at(2)}>
          <T x={20} y={136} size={9.5} face="font-sans" tone="fill-neutral-400">
            Ship date
          </T>
          <T
            x={172}
            y={136}
            size={9.5}
            face="font-sans"
            tone="fill-neutral-400"
          >
            Pallets
          </T>
          <rect
            x={20}
            y={142}
            width={140}
            height={26}
            rx={6}
            className="lp-field"
          />
          <rect
            x={172}
            y={142}
            width={128}
            height={26}
            rx={6}
            className="lp-field"
          />
          <T x={20} y={188} size={9.5} face="font-sans" tone="fill-neutral-400">
            Notes
          </T>
          <rect
            x={20}
            y={194}
            width={280}
            height={40}
            rx={6}
            className="lp-field"
          />
          <rect
            x={20}
            y={248}
            width={72}
            height={26}
            rx={7}
            className="fill-primary"
          />
          <T
            x={56}
            y={265}
            size={11}
            face="font-sans"
            tone="fill-primary-foreground"
            middle
            bold
          >
            Send
          </T>
        </g>
        <T
          x={30}
          y={159.5}
          size={11.5}
          face="font-sans"
          tone="fill-neutral-50"
          part="lp-type"
          style={at(3)}
        >
          12 Nov
        </T>
        <T
          x={182}
          y={159.5}
          size={11.5}
          face="font-sans"
          tone="fill-neutral-50"
          part="lp-type"
          style={at(3.6)}
        >
          18
        </T>
        <T
          x={30}
          y={212}
          size={11.5}
          face="font-sans"
          tone="fill-neutral-50"
          part="lp-type"
          style={at(4.1)}
        >
          Dock B, after 9 am
        </T>
        <rect
          x={20}
          y={248}
          width={72}
          height={26}
          rx={7}
          className="lp-ping fill-none stroke-primary"
          strokeWidth={2}
          style={at(4.9)}
        />
        <g transform="translate(104 251)">
          <g className="lp-in" style={at(5.1)}>
            <rect
              width={152}
              height={20}
              rx={10}
              className="fill-success-300/10 stroke-success-300/40"
            />
            <circle cx={11} cy={10} r={3} className="fill-success-300" />
            <T x={21} y={13.4} size={8.5} tone="fill-success-300">
              Saved for sara@acme.com
            </T>
          </g>
        </g>
      </g>

      {/* The folder the agent pushed, with its kit. */}
      <g className="lp-in" style={at(0.8)}>
        <T x={4} y={112} size={10}>
          acme/
        </T>
        <path
          d="M8 118V184M8 130H14M8 148H14M8 166H14M8 184H14"
          className="fill-none stroke-neutral-700"
        />
        <T x={18} y={134} size={9.5} tone="fill-brand-200">
          _theme.css
        </T>
        <T x={18} y={152} size={9.5} tone="fill-brand-200">
          _layout.html
        </T>
        <T x={18} y={170} size={9.5} tone="fill-brand-200">
          _components/
        </T>
        <T x={18} y={188} size={9.5} tone="fill-neutral-50">
          questions.html
        </T>
      </g>
      <Flash x={2} y={123} w={104} h={15} when={1} />
      <Flash x={2} y={141} w={104} h={15} when={1.2} />
      <Flash x={2} y={177} w={104} h={15} when={1.6} />

      {/* The agent's push. */}
      <g>
        <Frame w={224} h={84} console title="agent" />
        <Prompt x={12} y={42} when={0.2}>
          dossier push ./acme
        </Prompt>
        <T
          x={24}
          y={57}
          size={9.5}
          tone="fill-neutral-100"
          part="lp-type"
          style={at(0.6)}
        >
          agent964/acme
        </T>
        <g className="lp-in" style={at(1)}>
          <Check x={12} y={70} />
          <T x={24} y={73.5} size={9.5} tone="fill-success-300">
            push 12 · 4 files
          </T>
        </g>
      </g>

      {/* The agent reads the answers back. */}
      <g transform="translate(220 336)">
        <Frame w={220} h={116} console title="agent" />
        <Prompt x={12} y={42} when={5.7}>
          dossier read
        </Prompt>
        <T
          x={24}
          y={57}
          size={9.5}
          tone="fill-neutral-100"
          part="lp-type"
          style={at(6.1)}
        >
          agent964/acme/answers/
        </T>
        <T
          x={12}
          y={76}
          size={9.5}
          tone="fill-neutral-50"
          part="lp-in"
          style={at(6.6)}
        >
          # answers/ (1 file)
        </T>
        <T
          x={12}
          y={91}
          size={9}
          tone="fill-neutral-400"
          part="lp-in"
          style={at(6.8)}
        >
          sara@acme.com · push 12
        </T>
        <T
          x={12}
          y={105}
          size={9}
          tone="fill-complement-400"
          part="lp-in"
          style={at(7)}
        >
          {'{"ship":"12 Nov","pallets":18}'}
        </T>
      </g>
    </Figure>
  )
}

// ---------------------------------------------------------------------------
// The kit: what is above applies below
// ---------------------------------------------------------------------------

/** The chart component's bars: where each stands, how tall, its tone. */
const CHART: readonly (readonly [number, number, string])[] = [
  [78, 18, 'fill-brand-300/45'],
  [98, 30, 'fill-brand-300/60'],
  [118, 24, 'fill-brand-300/75'],
  [138, 42, 'fill-primary'],
  [158, 34, 'fill-brand-300/80'],
]

export function KitFigure() {
  return (
    <Figure
      width={440}
      height={292}
      label="A folder holds a theme, a layout and a chart component. The page q3.html, two folders below, takes all three and adds only its own content: 29 KB, where the same page made self-contained is 562 KB."
    >
      <g>
        <rect
          width={196}
          height={200}
          rx={12}
          className="lp-frame lp-surface"
        />
        <T x={14} y={23}>
          agent964/acme/
        </T>
        <path d="M0 34H196" className="stroke-border" />
        <path
          d="M20 46V142M20 56H26M20 78H26M20 100H26M20 142H26M36 108V120H42M36 150V182M36 162H42M36 182H42"
          className="fill-none stroke-neutral-700"
        />
        <Flash x={8} y={47} w={180} h={18} when={0.3} />
        <Flash x={8} y={69} w={180} h={18} when={1.6} />
        <Flash x={24} y={111} w={164} h={18} when={2.9} />
        <Flash x={24} y={153} w={164} h={18} when={4.4} />
        <T x={30} y={60} tone="fill-brand-200">
          _theme.css
        </T>
        <circle cx={178} cy={56} r={5} className="fill-primary" />
        <T x={30} y={82} tone="fill-brand-200">
          _layout.html
        </T>
        <path
          d="M172 73h12v10h-12zM172 76h12M176 76v7"
          className="fill-none stroke-brand-300"
        />
        <T x={30} y={104} tone="fill-brand-200">
          _components/
        </T>
        <T x={46} y={124} tone="fill-brand-200">
          acme-chart.js
        </T>
        <path
          d="M173 126v-5M178 126v-9M183 126v-7"
          className="stroke-brand-300"
          strokeWidth={2.5}
        />
        <T x={30} y={146}>
          plans/
        </T>
        <T x={46} y={166} tone="fill-neutral-50">
          q3.html
        </T>
        <T x={184} y={166} tone="fill-neutral-400" end>
          29 KB
        </T>
        <T x={46} y={186}>
          q4.html
        </T>
        <T x={184} y={186} tone="fill-neutral-400" end>
          31 KB
        </T>
        <Packet x={20} y={56} style={trip(0.4, 22, 86, [0, 86])} />
        <Packet x={20} y={78} style={trip(1.7, 22, 64, [0, 64])} />
        <Packet x={20} y={100} style={trip(3, 22, 42, [0, 42])} />
      </g>

      <g transform="translate(216 0)">
        <Frame w={224} h={200} url={['acme/plans/q3', 46]} />
        {/* The page's own corners, which the Look's radius sets. */}
        <clipPath id="lp-kit-page">
          <rect width={224} height={200} rx={12} className="lp-frame" />
        </clipPath>
        <g className="lp-in" style={at(1.4)}>
          <rect
            y={24}
            width={224}
            height={176}
            clipPath="url(#lp-kit-page)"
            className="fill-brand-300/5"
          />
          <T x={212} y={192} size={8} tone="fill-brand-200" end>
            _theme.css
          </T>
        </g>
        <g className="lp-in" style={at(2.7)}>
          <rect y={24} width={224} height={28} className="fill-brand-300/10" />
          <rect
            x={12}
            y={32}
            width={12}
            height={12}
            rx={3}
            className="fill-primary"
          />
          <T
            x={30}
            y={42}
            size={10.5}
            face="font-clash"
            tone="fill-neutral-50"
            bold
          >
            Acme
          </T>
          <T x={212} y={41.5} size={8} tone="fill-brand-200" end>
            _layout.html
          </T>
          <rect
            y={52}
            width={52}
            height={148}
            clipPath="url(#lp-kit-page)"
            className="fill-neutral-800/50"
          />
          <path d="M52 52V200M0 52H224" className="stroke-border" />
          <rect
            x={10}
            y={66}
            width={30}
            height={4}
            rx={2}
            className="fill-primary"
          />
          <rect
            x={10}
            y={78}
            width={24}
            height={4}
            rx={2}
            className="fill-neutral-700"
          />
          <rect
            x={10}
            y={90}
            width={32}
            height={4}
            rx={2}
            className="fill-neutral-700"
          />
        </g>
        <g className="lp-in" style={at(4.6)}>
          <T
            x={66}
            y={74}
            size={14}
            face="font-clash"
            tone="fill-neutral-50"
            bold
          >
            Q3 plan
          </T>
          <rect
            x={66}
            y={82}
            width={124}
            height={4}
            rx={2}
            className="fill-neutral-700"
          />
          <rect
            x={66}
            y={91}
            width={96}
            height={4}
            rx={2}
            className="fill-neutral-700"
          />
        </g>
        <g className="lp-in" style={at(3.9)}>
          <rect
            x={66}
            y={104}
            width={144}
            height={74}
            rx={8}
            className="lp-field"
          />
          <T x={202} y={117} size={8} tone="fill-brand-200" end>
            {'<acme-chart>'}
          </T>
        </g>
        {CHART.map(([x, h, tone], i) => (
          <rect
            key={x}
            x={x}
            y={170 - h}
            width={12}
            height={h}
            rx={2}
            className={`lp-rise ${tone}`}
            style={at(4 + i * 0.12)}
          />
        ))}
      </g>

      {/* What the page weighs, against the same page made self-contained. */}
      <T x={0} y={232}>
        q3.html
      </T>
      <T x={440} y={232} tone="fill-neutral-50" end>
        29 KB
      </T>
      <rect
        y={240}
        width={440}
        height={8}
        rx={4}
        className="fill-neutral-800/60"
      />
      <rect
        y={240}
        width={23}
        height={8}
        rx={4}
        className="lp-grow fill-primary"
        style={at(5.2)}
      />
      <T x={0} y={272} face="font-sans" tone="fill-neutral-400">
        The same page, self-contained
      </T>
      <T x={440} y={272} end>
        562 KB
      </T>
      <rect
        y={280}
        width={440}
        height={8}
        rx={4}
        className="fill-neutral-800/60"
      />
      <rect
        y={280}
        width={440}
        height={8}
        rx={4}
        className="lp-grow fill-neutral-600"
        style={at(5.6)}
      />
    </Figure>
  )
}

// ---------------------------------------------------------------------------
// Forms that remember: one person's answers, on any device
// ---------------------------------------------------------------------------

export function FormsFigure() {
  return (
    <Figure
      width={440}
      height={268}
      label="Sara answers on her phone in the morning. Dossier keeps her answers in a file of her own on the server, and in the evening her laptop opens the same page with her answers filled in."
    >
      <rect width={124} height={232} rx={22} className="lp-surface" />
      <rect
        x={46}
        y={10}
        width={32}
        height={7}
        rx={3.5}
        className="fill-neutral-800"
      />
      <T x={14} y={46} size={12} face="font-clash" tone="fill-neutral-50" bold>
        Questions
      </T>
      <T x={14} y={70} size={8.5} face="font-sans" tone="fill-neutral-400">
        Ship date
      </T>
      <rect x={14} y={75} width={96} height={22} rx={6} className="lp-field" />
      <T
        x={22}
        y={90}
        face="font-sans"
        tone="fill-neutral-50"
        part="lp-type"
        style={at(0.4)}
      >
        12 Nov
      </T>
      <T x={14} y={114} size={8.5} face="font-sans" tone="fill-neutral-400">
        Pallets
      </T>
      <rect x={14} y={119} width={96} height={22} rx={6} className="lp-field" />
      <T
        x={22}
        y={134}
        face="font-sans"
        tone="fill-neutral-50"
        part="lp-type"
        style={at(1)}
      >
        18
      </T>
      <rect
        x={14}
        y={154}
        width={96}
        height={22}
        rx={6}
        className="fill-primary"
      />
      <T
        x={62}
        y={168.5}
        size={9.5}
        face="font-sans"
        tone="fill-primary-foreground"
        middle
        bold
      >
        Send
      </T>
      <rect
        x={14}
        y={154}
        width={96}
        height={22}
        rx={6}
        className="lp-ping fill-none stroke-primary"
        strokeWidth={2}
        style={at(1.7)}
      />
      <g className="lp-in" style={at(1.9)}>
        <rect
          x={14}
          y={188}
          width={96}
          height={18}
          rx={9}
          className="fill-success-300/10 stroke-success-300/40"
        />
        <Check x={24} y={197} />
        <T x={36} y={200.2} size={8} tone="fill-success-300">
          Sent 09:12
        </T>
      </g>

      <path
        d="M124 116H148"
        pathLength={1}
        className="lp-draw fill-none stroke-neutral-600"
        style={at(2)}
      />
      <Packet x={124} y={116} style={trip(2.1, 24, 0)} />
      <g transform="translate(148 64)">
        <rect
          width={140}
          height={104}
          rx={12}
          className="lp-frame lp-surface"
        />
        <T x={12} y={17} size={9} tone="fill-neutral-400">
          answers/
        </T>
        <path d="M0 26H140" className="stroke-border" />
        <g className="lp-in" style={at(2.4)}>
          <path d="M12 34h7l3 3v9H12z" className="fill-none stroke-brand-300" />
          <T x={27} y={44} size={8.5} tone="fill-neutral-50">
            sara@acme.com.json
          </T>
        </g>
        <T x={12} y={68} size={8.5} part="lp-type" style={at(2.7)}>
          "ship": <tspan className="fill-complement-400">"12 Nov"</tspan>
        </T>
        <T x={12} y={84} size={8.5} part="lp-type" style={at(3)}>
          "pallets": <tspan className="fill-complement-400">18</tspan>
        </T>
      </g>

      <path
        d="M288 116H300"
        pathLength={1}
        className="lp-draw fill-none stroke-neutral-600"
        style={at(3.4)}
      />
      <Packet x={288} y={116} style={trip(3.5, 12, 0)} />
      <g transform="translate(300 54)">
        <rect width={134} height={112} rx={8} className="lp-surface" />
        <path
          d="M-6 114H140l-7 8H1Z"
          className="fill-neutral-800 stroke-border"
        />
        <T
          x={12}
          y={22}
          size={10}
          face="font-clash"
          tone="fill-neutral-50"
          bold
        >
          Questions
        </T>
        <T x={12} y={40} size={7.5} face="font-sans" tone="fill-neutral-400">
          Ship date
        </T>
        <rect
          x={12}
          y={44}
          width={110}
          height={20}
          rx={5}
          className="lp-field"
        />
        <Flash x={12} y={44} w={110} h={20} when={3.8} />
        <T
          x={19}
          y={57.5}
          size={9}
          face="font-sans"
          tone="fill-neutral-50"
          part="lp-in"
          style={at(3.8)}
        >
          12 Nov
        </T>
        <T x={12} y={78} size={7.5} face="font-sans" tone="fill-neutral-400">
          Pallets
        </T>
        <rect
          x={12}
          y={82}
          width={110}
          height={20}
          rx={5}
          className="lp-field"
        />
        <Flash x={12} y={82} w={110} h={20} when={4} />
        <T
          x={19}
          y={95.5}
          size={9}
          face="font-sans"
          tone="fill-neutral-50"
          part="lp-in"
          style={at(4)}
        >
          18
        </T>
      </g>

      <T x={62} y={262} size={8} tone="fill-neutral-500" middle>
        PHONE · MORNING
      </T>
      <T x={218} y={262} size={8} tone="fill-neutral-500" middle>
        ON THE SERVER
      </T>
      <T x={367} y={262} size={8} tone="fill-neutral-500" middle>
        LAPTOP · EVENING
      </T>
    </Figure>
  )
}

// ---------------------------------------------------------------------------
// Sharing: a role on a folder reaches everything in it
// ---------------------------------------------------------------------------

/** One share in the dialog: who, what they are, and their role. */
function ShareRow({
  y,
  when,
  avatar,
  name,
  about,
  role,
  roleTone,
}: {
  y: number
  when: number
  avatar: ReactNode
  name: string
  about: string
  role: string
  roleTone: readonly [string, string]
}) {
  return (
    <g transform={`translate(16 ${y})`}>
      <g className="lp-in" style={at(when)}>
        {avatar}
        <T x={36} y={11} face="font-sans" tone="fill-neutral-50">
          {name}
        </T>
        <T x={36} y={25} size={8} face="font-sans" tone="fill-neutral-400">
          {about}
        </T>
        <rect
          x={176}
          y={4}
          width={60}
          height={18}
          rx={5}
          className={roleTone[0]}
        />
        <T x={206} y={16.5} size={8.5} tone={roleTone[1]} middle>
          {role}
        </T>
      </g>
    </g>
  )
}

const READ_CHIP = [
  'fill-neutral-800/70 stroke-border',
  'fill-neutral-300',
] as const

export function SharingFigure() {
  const shares = [1.1, 2.1, 3.1, 4.1]
  return (
    <Figure
      width={440}
      height={284}
      label="Sharing the folder questions/: Sara responds, the Design team writes, the workspace reads, and anyone with the link reads without signing in. Each share covers every file in the folder, and nothing beside it."
    >
      <g transform="translate(0 44)">
        <rect
          width={152}
          height={180}
          rx={12}
          className="lp-frame lp-surface"
        />
        <T x={12} y={20} size={9.5}>
          agent964/acme/
        </T>
        <path d="M0 30H152" className="stroke-border" />
        <rect
          x={8}
          y={39}
          width={136}
          height={20}
          rx={5}
          className="fill-brand-300/10 stroke-brand-300/60"
        />
        <T x={22} y={53} size={9.5} tone="fill-neutral-50">
          questions/
        </T>
        <path
          d="M28 60V114M28 74H34M28 94H34M28 114H34M14 136H20"
          className="fill-none stroke-neutral-700"
        />
        {shares.map((when) => (
          <Flash key={when} x={32} y={64} w={112} h={60} when={when + 0.1} />
        ))}
        <T x={40} y={78} size={9.5} tone="fill-neutral-300">
          index.html
        </T>
        <T x={40} y={98} size={9.5} tone="fill-neutral-300">
          brief.pdf
        </T>
        <T x={40} y={118} size={9.5} tone="fill-neutral-300">
          answers/
        </T>
        <T x={22} y={140} size={9.5} tone="fill-neutral-400">
          budget/
        </T>
        <T x={22} y={162} size={8} face="font-sans" tone="fill-neutral-500">
          not shared
        </T>
      </g>

      <g transform="translate(172 0)">
        <rect
          width={268}
          height={284}
          rx={12}
          className="lp-frame lp-surface"
        />
        <T x={16} y={26} size={12} face="font-sans" tone="fill-neutral-50" bold>
          Share questions/
        </T>
        <T x={16} y={42} size={8.5} tone="fill-neutral-400">
          agent964/acme
        </T>
        <path d="M0 54H268" className="stroke-border" />
        <rect
          x={16}
          y={66}
          width={236}
          height={26}
          rx={6}
          className="lp-field"
        />
        <T
          x={26}
          y={83}
          face="font-sans"
          tone="fill-neutral-50"
          part="lp-type"
          style={at(0.3)}
        >
          sara@acme.com
        </T>
        <ShareRow
          y={108}
          when={shares[0]!}
          avatar={
            <>
              <circle
                cx={13}
                cy={13}
                r={13}
                className="fill-complement-400/15 stroke-complement-400/40"
              />
              <T
                x={13}
                y={17}
                face="font-sans"
                tone="fill-complement-400"
                middle
                bold
              >
                S
              </T>
            </>
          }
          name="sara@acme.com"
          about="Guest, signs in with Google"
          role="Respond"
          roleTone={[
            'fill-complement-400/10 stroke-complement-400/35',
            'fill-complement-400',
          ]}
        />
        <ShareRow
          y={150}
          when={shares[1]!}
          avatar={
            <>
              <rect
                width={26}
                height={26}
                rx={7}
                className="fill-brand-300/12 stroke-brand-300/35"
              />
              <circle cx={10} cy={11} r={3} className="fill-brand-300" />
              <circle cx={17} cy={11} r={3} className="fill-brand-300/60" />
              <path
                d="M5 20a5 4 0 0 1 10 0M12 20a5 4 0 0 1 10 0"
                className="fill-none stroke-brand-300"
              />
            </>
          }
          name="Design"
          about="Team, 4 people"
          role="Write"
          roleTone={['fill-brand-300/10 stroke-brand-300/35', 'fill-brand-200']}
        />
        <ShareRow
          y={192}
          when={shares[2]!}
          avatar={
            <>
              <rect
                width={26}
                height={26}
                rx={7}
                className="fill-neutral-800 stroke-border"
              />
              <T
                x={13}
                y={17}
                face="font-sans"
                tone="fill-neutral-300"
                middle
                bold
              >
                A
              </T>
            </>
          }
          name="agent964"
          about="Everyone in the workspace"
          role="Read"
          roleTone={READ_CHIP}
        />
        <ShareRow
          y={234}
          when={shares[3]!}
          avatar={
            <>
              <rect
                width={26}
                height={26}
                rx={7}
                className="fill-neutral-800 stroke-border"
              />
              <circle
                cx={13}
                cy={13}
                r={7}
                className="fill-none stroke-neutral-300"
              />
              <ellipse
                cx={13}
                cy={13}
                rx={3}
                ry={7}
                className="fill-none stroke-neutral-300"
              />
              <path d="M6 13h14" className="fill-none stroke-neutral-300" />
            </>
          }
          name="Anyone with the link"
          about="Opens it without signing in"
          role="Read"
          roleTone={READ_CHIP}
        />
      </g>
    </Figure>
  )
}

// ---------------------------------------------------------------------------
// Companions: what an agent reads instead of the HTML
// ---------------------------------------------------------------------------

export function CompanionFigure() {
  return (
    <Figure
      width={440}
      height={290}
      label="Beside questions.html sits questions.md, its companion. dossier read returns the companion, ending with where the page's answers and comments are, and dossier watch waits for the next answer."
    >
      <T x={0} y={10} size={8} tone="fill-neutral-500">
        FOR PEOPLE
      </T>
      <g transform="translate(0 18)">
        <rect
          width={176}
          height={112}
          rx={12}
          className="lp-frame lp-surface"
        />
        <T x={12} y={17} size={9}>
          questions.html
        </T>
        <path d="M0 26H176" className="stroke-border" />
        <T x={12} y={44} size={8} tone="fill-neutral-500">
          {'<main class="q">'}
        </T>
        <T x={20} y={58} size={8} tone="fill-neutral-500">
          {'<h1>Delivery questions'}
        </T>
        <T x={20} y={72} size={8} tone="fill-neutral-500">
          {'<form method="post">'}
        </T>
        <T x={28} y={86} size={8} tone="fill-neutral-500">
          {'<input name="ship">'}
        </T>
        <T x={28} y={100} size={8} tone="fill-neutral-500">
          {'<input name="pallets">'}
        </T>
      </g>
      <T x={0} y={160} size={8} tone="fill-neutral-500">
        FOR AGENTS
      </T>
      <g transform="translate(0 168)">
        <rect
          width={176}
          height={112}
          rx={12}
          className="lp-frame lp-surface"
        />
        <rect
          width={176}
          height={112}
          rx={12}
          className="lp-frame fill-none stroke-brand-300/50"
        />
        <rect
          width={176}
          height={112}
          rx={12}
          className="lp-frame lp-flash fill-brand-300/10"
          style={at(1)}
        />
        <T x={12} y={17} size={9} tone="fill-brand-200">
          questions.md
        </T>
        <path d="M0 26H176" className="stroke-border" />
        <T x={12} y={46} size={9} tone="fill-neutral-50">
          # Delivery questions
        </T>
        <T x={12} y={63} size={8.5}>
          Ask for the ship date
        </T>
        <T x={12} y={77} size={8.5}>
          and the pallet count.
        </T>
        <T x={12} y={95} size={8.5} tone="fill-neutral-400">
          One answer per person.
        </T>
      </g>
      <path
        d="M176 224H196"
        pathLength={1}
        className="lp-draw fill-none stroke-brand-300/60"
        style={at(1)}
      />
      <Packet x={176} y={224} style={trip(1.1, 20, 0)} />

      <g transform="translate(196 22)">
        <Frame w={244} h={252} console title="agent" />
        <Prompt x={12} y={42} when={0.2}>
          dossier read
        </Prompt>
        <T
          x={24}
          y={57}
          size={9.5}
          tone="fill-neutral-100"
          part="lp-type"
          style={at(0.6)}
        >
          agent964/acme/questions.html
        </T>
        <g className="lp-in" style={at(1.6)}>
          <T x={12} y={80} size={9.5} tone="fill-neutral-50">
            # Delivery questions
          </T>
          <T x={12} y={96} size={9}>
            Ask for the ship date
          </T>
          <T x={12} y={110} size={9}>
            and the pallet count.
          </T>
        </g>
        <T
          x={12}
          y={130}
          size={9}
          tone="fill-complement-400"
          part="lp-in"
          style={at(2.3)}
        >
          Data: answers/ (3 files)
        </T>
        <T
          x={12}
          y={144}
          size={9}
          tone="fill-complement-400"
          part="lp-in"
          style={at(2.4)}
        >
          Comments: 2
        </T>
        <Prompt x={12} y={176} when={3.2}>
          dossier watch --next
        </Prompt>
        <T
          x={24}
          y={191}
          size={9.5}
          tone="fill-neutral-100"
          part="lp-type"
          style={at(3.6)}
        >
          agent964/acme/questions/
        </T>
        <g className="lp-in" style={at(5)}>
          <Check x={12} y={210} />
          <T x={24} y={213.5} size={9} tone="fill-success-300">
            submission answers/
          </T>
          <T x={24} y={228} size={9}>
            lina@acme.com.json
          </T>
        </g>
      </g>
    </Figure>
  )
}

// ---------------------------------------------------------------------------
// History: every push is one change, and a restore brings a file back
// ---------------------------------------------------------------------------

/** One point on the history line, with what it changed. */
function Point({
  x,
  when,
  label,
  what,
  tone,
  dot,
}: {
  x: number
  when: number
  label: string
  what: string
  tone: string
  dot: string
}) {
  return (
    <g className="lp-in" style={at(when)}>
      <circle cx={x} cy={92} r={7} className={dot} strokeWidth={2} />
      <T x={x} y={122} size={9.5} middle>
        {label}
      </T>
      <T x={x} y={138} size={9.5} face="font-sans" tone={tone} middle>
        {what}
      </T>
    </g>
  )
}

export function HistoryFigure() {
  return (
    <Figure
      width={440}
      height={214}
      label="Four points in a tree's history: pushes 10, 11 and 12, where push 12 deleted plan.html, then a restore to push 11 that brings plan.html back."
    >
      <path
        d="M20 92H420"
        pathLength={1}
        className="lp-draw fill-none stroke-neutral-700"
        style={at(0.2)}
      />
      <Point
        x={52}
        when={0.5}
        label="push 10"
        what="Questions"
        tone="fill-neutral-400"
        dot="fill-card stroke-brand-300"
      />
      <Point
        x={164}
        when={1.2}
        label="push 11"
        what="Pallet count"
        tone="fill-neutral-400"
        dot="fill-card stroke-brand-300"
      />
      <Point
        x={276}
        when={1.9}
        label="push 12"
        what="plan.html deleted"
        tone="fill-error-300"
        dot="fill-card stroke-error-300"
      />
      <path
        d="M168 83C192 22 362 22 384 82"
        pathLength={1}
        className="lp-draw fill-none stroke-success-300"
        strokeWidth={1.5}
        style={at(3.4)}
      />
      <g className="lp-in" style={at(4.1)}>
        <path
          d="M377 76l7 6 2-9"
          className="fill-none stroke-success-300"
          strokeWidth={1.5}
        />
        <T x={276} y={30} size={8.5} tone="fill-success-300" middle>
          --to 11
        </T>
      </g>
      <Point
        x={388}
        when={4.3}
        label="restore"
        what="plan.html is back"
        tone="fill-success-300"
        dot="fill-success-300 stroke-success-300"
      />
      <circle
        cx={388}
        cy={92}
        r={7}
        className="lp-ping fill-none stroke-success-300"
        strokeWidth={2}
        style={at(4.4)}
      />
      <g transform="translate(0 162)">
        <rect width={440} height={50} rx={12} className="lp-frame lp-console" />
        <Prompt x={14} y={29} when={2.6}>
          dossier restore agent964/acme/plan.html --to 11
        </Prompt>
      </g>
    </Figure>
  )
}
