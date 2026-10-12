// <acme-badge>: a small label. Its shared look comes from the sibling module
// beside it, whichever folder the page that uses it sits in.
import { tone } from './shared.js'

class AcmeBadge extends HTMLElement {
  connectedCallback() {
    this.style.cssText = `display:inline-block;padding:2px 8px;border-radius:999px;font-size:13px;${tone}`
    if (!this.textContent.trim()) this.textContent = 'New'
  }
}
customElements.define('acme-badge', AcmeBadge)
