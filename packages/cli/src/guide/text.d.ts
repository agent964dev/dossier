// The guide's conventions are Markdown files the CLI carries as text.
declare module '*.md' {
  const text: string
  export default text
}
