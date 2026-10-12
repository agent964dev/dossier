import { noteLabel } from '../note-text.js'

customElements.define(
  'acme-note',
  class extends HTMLElement {
    connectedCallback() {
      const label = document.createElement('strong')
      label.textContent = `${noteLabel} `
      this.prepend(label)
      this.style.cssText =
        'display:block;border-left:4px solid var(--accent);padding:.5em 1em;background:#eef4fa'
    }
  },
)
