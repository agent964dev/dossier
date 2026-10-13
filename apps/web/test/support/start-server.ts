// Stands in for @tanstack/react-start/server, which Better Auth's TanStack
// cookie plugin imports. Outside a TanStack request, setting a cookie throws,
// as the real one does; the edge forwards Better Auth's cookies itself.
export function setCookie(): never {
  throw new Error('No TanStack request is running')
}
