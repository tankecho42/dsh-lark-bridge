export function pngFixture() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ])
}

export function createFeishuResourceSimulator(resources) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/\/resources\/([^/]+)$/)
    const key = match ? decodeURIComponent(match[1]) : ''
    calls.push({ url: String(url), init, key })
    const resource = resources[key]
    if (!resource) {
      return new Response(JSON.stringify({ code: 234001, msg: 'resource not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(resource.data, {
      status: resource.status || 200,
      headers: {
        'content-type': resource.mediaType || 'application/octet-stream',
        'content-length': String(resource.declaredBytes ?? resource.data.byteLength),
        ...(resource.fileName ? { 'content-disposition': `attachment; filename="${resource.fileName}"` } : {}),
      },
    })
  }
  return { fetchImpl, calls }
}

export function createDshSimulator(defaultCwd) {
  const calls = { creates: [], resumes: [], prompts: [], images: [] }
  const handles = new Map()
  const makeHandle = (id) => {
    const handle = {
      agent: {
        id,
        followup(message) { calls.prompts.push({ id, message }) },
        cancel() {},
      },
      async dispose() { handles.delete(id) },
    }
    handles.set(id, handle)
    return handle
  }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'sim-provider', model: 'sim-model' }) },
    agents: {
      async create(options) {
        calls.creates.push(options)
        return makeHandle(String(options.sessionId))
      },
      async resume(options) {
        calls.resumes.push(options)
        const handle = handles.get(String(options.resumeSessionId))
        if (!handle) throw new Error('simulated session missing')
        return handle
      },
    },
    attachments: {
      async saveImages(inputs) {
        calls.images.push(...inputs)
        return inputs.map((input, index) => ({
          attachmentId: `sha256:sim-${index}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          ...(input.name ? { name: input.name } : {}),
        }))
      },
    },
  }
  return { ctx, calls, handles, defaultCwd }
}
