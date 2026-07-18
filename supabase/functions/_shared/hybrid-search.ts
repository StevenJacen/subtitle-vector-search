import {
  mapSearchResults,
  type MatchSubtitleChunkRow,
  type SearchResult,
  type SubtitleCueRow,
} from './search.ts'

export interface HybridMatchSubtitleChunkRow extends MatchSubtitleChunkRow {
  rrf_score: number
  semantic_rank: number | null
  full_text_rank: number | null
}

export interface HybridSearchResult extends SearchResult {
  rrfScore: number
  semanticRank: number | null
  fullTextRank: number | null
}

export function mapHybridSearchResults(
  rows: HybridMatchSubtitleChunkRow[],
  cueRows: SubtitleCueRow[],
): HybridSearchResult[] {
  const baseResults = mapSearchResults(rows, cueRows)

  return baseResults.map((result, index) => {
    const row = rows[index]
    if (!Number.isFinite(row.rrf_score)
      || !validRank(row.semantic_rank)
      || !validRank(row.full_text_rank)
      || (row.semantic_rank === null && row.full_text_rank === null)) {
      throw new Error('invalid hybrid search result')
    }

    return {
      ...result,
      rrfScore: row.rrf_score,
      semanticRank: row.semantic_rank,
      fullTextRank: row.full_text_rank,
    }
  })
}

function validRank(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value > 0)
}
