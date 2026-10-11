import { Fragment } from 'react'

/**
 * A host name that wraps only after its dots, hyphens and colon, so a long
 * deployment name never breaks in the middle of a word.
 */
export function HostName({ host }: { host: string }) {
  const parts = host.split(/(?<=[.\-:])/)
  const starts = parts.map((_, index) =>
    parts.slice(0, index).reduce((length, part) => length + part.length, 0),
  )
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={starts[index]}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  )
}
