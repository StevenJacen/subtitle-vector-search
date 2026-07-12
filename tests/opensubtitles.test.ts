import { describe, expect, it, vi } from 'vitest'
import { OpenSubtitlesApiError, OpenSubtitlesClient } from '../src/opensubtitles.js'

const clientConfig = {
  apiKey: 'key',
  token: 'token',
  userAgent: 'research-app',
}

describe('OpenSubtitlesClient', () => {
  it('searches English subtitles by IMDb id with required headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({
      data: [{
        id: '42',
        attributes: { language: 'en', files: [{ file_id: 99, file_name: 'movie.srt' }] },
      }],
    }))
    const client = new OpenSubtitlesClient({ ...clientConfig, fetchFn })

    const result = await client.searchEnglishByImdb('0111161')

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.opensubtitles.com/api/v1/subtitles?imdb_id=0111161&languages=en',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Api-Key': 'key',
          Authorization: 'Bearer token',
          'User-Agent': 'research-app',
        }),
      }),
    )
    expect(result).toEqual([{
      subtitleId: '42',
      fileId: 99,
      fileName: 'movie.srt',
      language: 'en',
    }])
  })

  it('downloads a selected file through the returned one-time link', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(Response.json({ link: 'https://downloads.example/movie.srt', file_name: 'movie.srt' }))
      .mockResolvedValueOnce(new Response('subtitle bytes'))
    const client = new OpenSubtitlesClient({ ...clientConfig, fetchFn })

    const result = await client.downloadFile(99)

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://api.opensubtitles.com/api/v1/download',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ file_id: 99 }),
        headers: expect.objectContaining({
          'Api-Key': 'key',
          Authorization: 'Bearer token',
          'User-Agent': 'research-app',
        }),
      }),
    )
    expect(fetchFn).toHaveBeenNthCalledWith(2, 'https://downloads.example/movie.srt')
    expect(result).toEqual({ fileName: 'movie.srt', bytes: new TextEncoder().encode('subtitle bytes') })
  })

  it('rejects subtitle search results without downloadable files', async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({
      data: [{ id: '42', attributes: { language: 'en', files: [] } }],
    }))
    const client = new OpenSubtitlesClient({ ...clientConfig, fetchFn })

    await expect(client.searchEnglishByImdb('0111161')).rejects.toThrow('no downloadable subtitle files found')
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [406, 'not_acceptable'],
    [429, 'rate_limited'],
  ])('maps HTTP %i to the %s API error', async (status, code) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'API error' }), { status }))
    const client = new OpenSubtitlesClient({ ...clientConfig, fetchFn, delayFn: vi.fn() })

    const error = await client.searchEnglishByImdb('0111161').catch(error => error)

    expect(error).toBeInstanceOf(OpenSubtitlesApiError)
    expect(error).toMatchObject({ status, code, message: 'API error' })
  })

  it('retries a rate-limited request at most three times and honors Retry-After', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'slow down' }), { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(Response.json({ data: [] }))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const client = new OpenSubtitlesClient({ ...clientConfig, fetchFn, delayFn })

    await expect(client.searchEnglishByImdb('0111161')).resolves.toEqual([])

    expect(delayFn).toHaveBeenCalledWith(2_000)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('stops retrying after three transient server failures', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 }))
    const delayFn = vi.fn().mockResolvedValue(undefined)
    const client = new OpenSubtitlesClient({ ...clientConfig, fetchFn, delayFn })

    await expect(client.searchEnglishByImdb('0111161')).rejects.toMatchObject({ status: 503 })

    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(delayFn).toHaveBeenCalledTimes(2)
  })
})
