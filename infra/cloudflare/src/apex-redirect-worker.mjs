const TARGET = 'https://www.healthidentitydirectory.com'

export default {
  fetch(request) {
    const incoming = new URL(request.url)
    if (incoming.hostname !== 'healthidentitydirectory.com') {
      return new Response('Misdirected request', { status: 421 })
    }
    const target = new URL(`${incoming.pathname}${incoming.search}`, TARGET)
    return new Response(null, {
      status: 308,
      headers: {
        location: target.toString(),
        'cache-control': 'public, max-age=300',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-content-type-options': 'nosniff',
      },
    })
  },
}
