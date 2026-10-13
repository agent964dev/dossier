// A module that imports in every way a module can.
import shared from './shared.js'
import { a, b as c } from "../lib/util.js"
import * as all from './all.js'
import './side-effect.js'
export * from './again.js'
export { d } from './named.js'
export default function card() {}
const text = "import nothing from './not-a-module.js'"
const other = 'export * from "./not-either.js"'
// import commented from './commented.js'
/* import block from './block.js' */
const lazy = () => import('./lazy.js')
const tpl = () => import(`./template.js`)
const computed = (name) => import('./' + name)
const sub = (n) => import(`./${n}.js`)
const meta = import.meta.url
const json = import('./data.json', { with: { type: 'json' } })
import esc from './\u0065scaped.js'
