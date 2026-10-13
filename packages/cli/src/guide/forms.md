## Forms

A plain `<form>` keeps each person's answers on the server, with no script in
the page. Its `action` names where they go, relative to the page:

- `action="answers/"`: one file per person, named by their email,
  `answers/sara@acme.com.json`. Sending again merges by field.
- `action="ideas/" data-entries="many"`: a new entry per send in the person's
  own folder, `ideas/sara@acme.com/2026-10-10T09-14-03.json`; the form empties
  for the next one.
- `action="decisions.json"`: one shared file every respondent merges into, field
  by field; the last write to a field wins and earlier values stay in history.

A push stops on a form without `action`, an `action` outside the tree or onto a
pushed file, a `_` path or a page, two forms with one target and no distinct
`id`s, and a `data-closes` without a time zone. Data folders are never pushed
over; a push leaves them alone.

The 13 rules every plain form follows:

1. Values are typed: text-like fields as text, `number` and `range` as numbers,
   a lone checkbox as true or false, a group of checkboxes as a list, radios and
   selects as the chosen value, `select multiple` as a list, dates and times as
   ISO text, a file as a reference to its upload, and the submit button used
   (with a name) as its value.
2. The server checks `required`, `min`, `max`, `step`, `minlength`,
   `maxlength`, `pattern`, input formats and the options offered, also for sends
   that bypass the page.
3. Field names the form does not have are refused.
4. Each value is shown under its `<label>`, or the `<legend>` of its
   `<fieldset>` for a group, on the responses screen.
5. Sending never leaves the page; it confirms and the form stays filled.
6. People who come back see what they last sent: their own file, or the shared
   file.
7. Unsent edits are kept as drafts in the person's browser.
8. A form without a submit button saves as people type, after a short pause.
9. Every write records who, when and which push the person saw; every revision
   is kept.
10. A page can hold several forms with different targets.
11. A shared file merges per field.
12. A send is checked against the form as the person saw it. Prefill matches by
    field name, and values of removed fields stay in the file but are not shown.
    A send to a form the current push no longer has is refused with "This form
    has changed. Reload the page to see the current version."
13. `<input type="file">` uploads first, at most 10 MiB, into the person's
    folder (`answers/sara@acme.com/files/cv.pdf`), and is served only as a
    download.

Close a form with `data-closes="2026-10-20T18:00+03:00"` (with `Z` or an offset)
or `data-closed`: people see their last answers read only, with "This form
closed on 20 October", and the server refuses sends. A
`<button data-dossier-withdraw>` in a per-person form lets the writer withdraw
their answer for good, closed or not. `data-dossier="off"` leaves a form to page
code; `data-dossier="manual"` keeps prefill, drafts and the status line but
sends only when page code lets a submit through. Each managed form carries
`data-state` (`idle`, `draft`, `sending`, `sent`, `failed`, `closed`) and fires
`dossier:state`; its status line is an `<output data-dossier-status>` styled by
the page.

State a page's script draws, such as a note on each of 500 items, goes in a JSON
field: a hidden input marked `data-type="json"`, optionally with a JSON object
as its starting `value`. It holds one JSON object under its name, in the
person's file or the shared file, wherever the form's other fields go, and the
data file's 1 MiB limit bounds it. Page code merges into it with `write`:

```html
<form action="review/">
  <input type="hidden" name="notes" data-type="json" value="{}" />
</form>
<script>
  dossier.write('review/~.json', {
    notes: { 'S-108': { text: 'Check the dates', reopen: true } },
  })
</script>
```

The merge follows RFC 7396 like every write, so `{ notes: { 'S-108': null } }`
removes one note. A value that is not a JSON object is refused with `invalid`,
and a push refuses a JSON field marked `required` or with a `value` that is not
an object. A plain send carries the field's `value` as JSON text, and prefill
puts the stored object back in it. The responses screen shows it folded.

Each data file is plain JSON keyed by field name. `dossier read answers/` gives
every file with who wrote it, when and the push they saw. People who can read
the folder see a page's responses in Dossier, and a listing shows "3 responses"
on the page; respondents see only their own answers.
