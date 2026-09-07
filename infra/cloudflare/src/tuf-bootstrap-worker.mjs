export default {
  fetch() {
    return new Response(JSON.stringify({
      type: 'about:blank',
      title: 'Repository unavailable',
      status: 503,
      code: 'BOOTSTRAP_PARENT_ONLY',
    }), {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/problem+json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    })
  },
}
