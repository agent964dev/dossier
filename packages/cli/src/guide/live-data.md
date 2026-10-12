## Live data

Live rendering belongs in a tree's kit, not in each page: write a component
once in `_components/`, and every page below uses it as a tag. It reads and
watches through the page client, so the page updates as people answer, with no
reload. This one counts the answers of a form by their `choice` field:

```js
// _components/acme-results.js
class AcmeResults extends HTMLElement {
  connectedCallback() {
    this.stop = dossier.watch(this.getAttribute('src'), (docs) =>
      this.render(docs ?? []),
    )
  }
  disconnectedCallback() {
    this.stop?.()
  }
  render(docs) {
    const counts = {}
    for (const d of docs)
      counts[d.data.choice] = (counts[d.data.choice] ?? 0) + 1
    this.replaceChildren(
      ...Object.entries(counts).map(([k, n]) =>
        Object.assign(document.createElement('p'), {
          textContent: `${k}: ${n}`,
        }),
      ),
    )
  }
}
customElements.define('acme-results', AcmeResults)
```

Any page below uses it, such as
`<acme-results src="../questions/answers/"></acme-results>`. Paths resolve from
the page, not the module, so `src` names the folder relative to the page that
holds the tag. `watch` calls back at once with what is there and again after
each change, and its function stops the watch when the element leaves the page.

Agents get the same events with `dossier watch <workspace>/<tree>/<path>`: one
line per event (time, type, path, who), or one JSON object per line with
`--json`. `--next` prints the first event and exits 0, so an agent can wait for
the next submission, then `dossier read` the folder.
