import type { DiffResponse } from '@dossier/contracts'

function range(start: number, lines: number): string {
  if (lines === 0) return `${start - 1},0`
  return lines === 1 ? String(start) : `${start},${lines}`
}

function prefixFor(op: string): ' ' | '+' | '-' {
  switch (op) {
    case 'context':
    case 'equal':
    case ' ':
      return ' '
    case 'add':
    case 'insert':
    case '+':
      return '+'
    case 'delete':
    case 'remove':
    case '-':
      return '-'
    default:
      throw new Error(`unsupported diff operation: ${op}`)
  }
}

function paint(text: string, code: number, color: boolean): string {
  const escape = String.fromCharCode(27)
  return color ? `${escape}[${code}m${text}${escape}[0m` : text
}

/** Neutralize terminal controls from stored document text, including OSC/CSI. */
function terminalSafe(text: string, terminal: boolean): string {
  if (!terminal) return text
  return text.replace(/\p{Cc}/gu, (control) => {
    const code = control.charCodeAt(0)
    return code === 9 || code === 10
      ? control
      : `\\x${code.toString(16).padStart(2, '0')}`
  })
}

function lineWithEnding(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

export function formatUnifiedDiff(
  response: DiffResponse,
  color = false,
  terminal = color,
): string {
  let output = ''
  output += `${paint(`--- a/${response.documentId}@${response.from.versionNumber}`, 1, color)}\n`
  output += `${paint(`+++ b/${response.documentId}@${response.to.versionNumber}`, 1, color)}\n`

  for (const hunk of response.hunks) {
    output += `${paint(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
      36,
      color,
    )}\n`
    for (const line of hunk.lines) {
      const prefix = prefixFor(line.op)
      const rendered = `${prefix}${lineWithEnding(terminalSafe(line.text, terminal))}`
      output +=
        prefix === '+'
          ? paint(rendered, 32, color)
          : prefix === '-'
            ? paint(rendered, 31, color)
            : rendered
      if (line.noNewline) output += '\\ No newline at end of file\n'
    }
  }

  return output
}
