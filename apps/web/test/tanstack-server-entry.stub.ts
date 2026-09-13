export default {
  fetch(): Response {
    return new Response(
      'TanStack handler is not loaded in Worker integration tests.',
      {
        status: 501,
      },
    )
  },
}
