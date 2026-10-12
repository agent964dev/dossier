// This folder's own <dossier-comments>: a plain list that reads and writes the
// same comment files as the base component, through the page client alone.
class FolderComments extends HTMLElement {
  async connectedCallback() {
    const dossier = window.dossier
    await dossier.ready
    const name = dossier.page.path
      .split('/')
      .pop()
      .replace(/\.html$/, '')
    const folder = `${name}.comments/`
    this.innerHTML =
      '<p class="kit-comments-title">Comments, from this folder’s own component</p>' +
      '<ul class="kit-comments-list"></ul>' +
      '<form data-dossier="off"><label>Comment <input name="text" required></label> <button>Add</button></form>' +
      '<p class="kit-comments-status" role="status"></p>'
    const list = this.querySelector('ul')
    const status = this.querySelector('[role=status]')
    const show = (threads) => {
      list.replaceChildren(
        ...(threads ?? []).map((thread) => {
          const item = document.createElement('li')
          const root = thread.data.root
          item.textContent = `${root.by}: ${root.deleted ? 'Comment deleted' : root.text} (${thread.data.replies.length} replies${thread.data.resolved ? ', resolved' : ''})`
          return item
        }),
      )
    }
    this.stop = dossier.watch(folder, show)
    this.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const form = event.target
      const text = new FormData(form).get('text')
      status.textContent = 'Saving…'
      try {
        await dossier.write(folder, {
          text,
          anchor: null,
          label: null,
          pin: null,
          replyTo: null,
          stance: null,
          mentions: [],
        })
        form.reset()
        status.textContent = 'Saved'
        show(await dossier.read(folder))
      } catch (error) {
        status.textContent = error.message
      }
    })
  }

  disconnectedCallback() {
    this.stop?.()
  }
}

customElements.define('dossier-comments', FolderComments)
