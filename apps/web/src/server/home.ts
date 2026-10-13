import { createServerFn } from '@tanstack/react-start'

import { homeModel } from './home-model.ts'
import { runScreen } from './run.ts'

// Types only: a value from the model would bring the core into the screens'
// client bundle.
export type {
  HomeTree,
  HomeView,
  SharedWithMe,
  WorkspaceMenuItem,
} from './home-model.ts'

export const homeView = createServerFn({ method: 'GET' })
  .validator((input: { readonly w?: string } | undefined) => ({
    w: typeof input?.w === 'string' ? input.w : null,
  }))
  .handler(({ data }) => runScreen(homeModel(data)))
