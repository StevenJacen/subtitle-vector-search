import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pgTap = readFileSync(
  resolve(process.cwd(), 'supabase/tests/database/private_subtitles.sql'),
  'utf8',
)

const tables = ['movies', 'subtitle_tracks', 'subtitle_cues', 'subtitle_chunks']
const publicRoles = ['anon', 'authenticated']
const tablePrivileges = ['select', 'insert', 'update', 'delete']
const sequencePrivileges = ['usage', 'select', 'update']

describe('private subtitle pgTAP contract', () => {
  it('requires exact empty search_path and HNSW cosine operator assertions', () => {
    expect(pgTap).toContain("setting = 'search_path='")
    expect(pgTap).toContain("operator_class.opcname = 'vector_cosine_ops'")
    expect(pgTap).toContain("operator_namespace.nspname = 'extensions'")
  })

  it('asserts every direct table and sequence privilege is denied to public roles', () => {
    for (const role of publicRoles) {
      for (const table of tables) {
        for (const privilege of tablePrivileges) {
          expect(pgTap).toContain(
            `not has_table_privilege('${role}', 'public.${table}', '${privilege}')`,
          )
        }
      }

      for (const table of tables) {
        for (const privilege of sequencePrivileges) {
          expect(pgTap).toContain(
            `not has_sequence_privilege('${role}', 'public.${table}_id_seq', '${privilege}')`,
          )
        }
      }
    }
  })

  it('asserts ready-track filtering, optional movie filtering, rank order, and result caps', () => {
    for (const assertion of [
      'only ready tracks are returned by match_subtitle_chunks',
      'optional movie filter returns only the requested movie',
      'nearest embedding ranks first',
      'match_count is clamped to one result',
      'match_count is capped at fifty results',
    ]) {
      expect(pgTap).toContain(assertion)
    }
  })
})
