export {
  buildPassageCueRanges,
  buildPassageResponse,
  deduplicatePassageCues,
  MAX_PASSAGE_CUE_RANGE_ROWS,
  NoEligiblePassageError,
  parsePassageRequest,
  PassageRequestError,
  selectContinuousPassage,
} from '../../supabase/functions/_shared/passage-selection.js'

export type {
  PassageAnchor,
  PassageCue,
  PassageCueRange,
  PassageRequest,
  SelectedPassage,
  SelectedPassageCue,
} from '../../supabase/functions/_shared/passage-selection.js'
