import { createServerFn } from '@tanstack/react-start'

import { homeModel } from './home-model.ts'
import { runScreen } from './run.ts'

export {
  menuOf,
  type HomeTree,
  type HomeView,
  type SharedWithMe,
  type WorkspaceMenuItem,
} from './home-model.ts'

export const homeView = createServerFn({ method: 'GET' })
  .validator((input: { readonly w?: string } | undefined) => ({
    w: typeof input?.w === 'string' ? input.w : null,
  }))
  .handler(({ data }) => runScreen(homeModel(data)))
