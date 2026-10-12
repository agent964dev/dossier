// This folder's own <dossier-copy>, which replaces the base layer's.
class FolderCopy extends HTMLElement {
  connectedCallback() {
    this.textContent = 'Copy (this folder’s own button)'
    this.setAttribute('data-folder-copy', '')
  }
}
if (!customElements.get('dossier-copy')) {
  customElements.define('dossier-copy', FolderCopy)
}
