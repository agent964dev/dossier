// <acme-card>: a card with a title line and a body, from its own text.
class AcmeCard extends HTMLElement {
  connectedCallback() {
    this.style.cssText =
      'display:block;max-width:22rem;padding:14px 16px;margin:12px 0;border-radius:10px;background:var(--card,#fff);border:1px solid #d6dde4;box-shadow:0 1px 2px #0001'
    const [title, ...rest] = this.textContent.trim().split('\n')
    this.innerHTML = ''
    const heading = document.createElement('strong')
    heading.textContent = title ?? ''
    const body = document.createElement('div')
    body.textContent = rest.join(' ').trim()
    this.append(heading, body)
  }
}
customElements.define('acme-card', AcmeCard)
