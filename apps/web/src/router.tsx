import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  // Links decide their own trailing slash: a folder's link ends in one.
  return createRouter({
    routeTree,
    scrollRestoration: true,
    trailingSlash: 'preserve',
  })
}
