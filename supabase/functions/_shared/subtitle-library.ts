export const READY_TRACK_PAGE_SIZE = 1_000

export async function collectReadyMovieIds(
  loadPage: (offset: number) => Promise<readonly { movie_id: number }[]>,
): Promise<Set<number>> {
  const movies = new Set<number>()
  for (let offset = 0; ; offset += READY_TRACK_PAGE_SIZE) {
    const rows = await loadPage(offset)
    if (rows.length > READY_TRACK_PAGE_SIZE) throw new Error('invalid ready-track page')
    for (const row of rows) movies.add(row.movie_id)
    if (rows.length < READY_TRACK_PAGE_SIZE) return movies
  }
}
