import { assertEmbedding } from './embeddings.ts'

export interface VisualConceptSeed {
  conceptKey: string
  description: string
  literalQuery: string
  actionQuery: string
  metaphorQuery: string
}

export const VISUAL_CONCEPT_SEEDS: readonly VisualConceptSeed[] = [
  {
    conceptKey: 'isolation',
    description: 'A lone person remains physically separated in a quiet and empty environment.',
    literalQuery: 'solitary person alone in empty room wide shot video',
    actionQuery: 'person sitting apart from crowd quiet distance video',
    metaphorQuery: 'single tree in vast foggy field cinematic video',
  },
  {
    conceptKey: 'reunion',
    description: 'People reconnect warmly after a meaningful period of separation.',
    literalQuery: 'friends meeting again warm embrace outdoor video',
    actionQuery: 'people running toward each other joyful reunion video',
    metaphorQuery: 'two paths joining in golden evening light aerial video',
  },
  {
    conceptKey: 'escape',
    description: 'A person urgently leaves confinement and moves toward an open route.',
    literalQuery: 'person leaving confined room through open doorway video',
    actionQuery: 'person running toward open landscape freedom video',
    metaphorQuery: 'bird flying out of open cage slow motion video',
  },
  {
    conceptKey: 'loss',
    description: 'An important absence leaves a person confronting an empty space.',
    literalQuery: 'person holding empty picture frame quiet room video',
    actionQuery: 'person packing away meaningful belongings reflective video',
    metaphorQuery: 'single leaf falling from bare branch slow motion video',
  },
  {
    conceptKey: 'hope',
    description: 'A difficult moment opens toward a credible and brighter future.',
    literalQuery: 'person opening curtains warm sunrise hopeful interior video',
    actionQuery: 'person walking from shadow into sunlight renewed purpose video',
    metaphorQuery: 'seedling emerging after rain in morning light macro video',
  },
  {
    conceptKey: 'conflict',
    description: 'Opposing forces meet in visible tension without a settled outcome.',
    literalQuery: 'two people facing each other tense disagreement video',
    actionQuery: 'people arguing with restrained gestures dramatic room video',
    metaphorQuery: 'storm waves colliding against rocky shore video',
  },
  {
    conceptKey: 'discovery',
    description: 'Careful exploration reveals something previously hidden or unknown.',
    literalQuery: 'person discovering hidden object with flashlight video',
    actionQuery: 'hands opening old box and examining contents video',
    metaphorQuery: 'sunbeam revealing path through dark forest video',
  },
  {
    conceptKey: 'time',
    description: 'Visible change marks the steady passage of moments and years.',
    literalQuery: 'clock hands moving close up time lapse video',
    actionQuery: 'busy city shifting from day to night time lapse video',
    metaphorQuery: 'long shadows crossing empty room time lapse video',
  },
  {
    conceptKey: 'memory',
    description: 'A present detail evokes a vivid but unreachable moment from the past.',
    literalQuery: 'person looking through old photographs reflective video',
    actionQuery: 'hands turning pages of worn photo album video',
    metaphorQuery: 'dust floating through projector light nostalgic video',
  },
  {
    conceptKey: 'transformation',
    description: 'A subject changes visibly from one meaningful state into another.',
    literalQuery: 'person changing appearance before mirror cinematic video',
    actionQuery: 'workspace changing from disorder to finished creation time lapse video',
    metaphorQuery: 'butterfly emerging from chrysalis macro video',
  },
  {
    conceptKey: 'love',
    description: 'Gentle attention and closeness show a durable bond between people.',
    literalQuery: 'couple sharing quiet affectionate moment natural light video',
    actionQuery: 'person caring for loved one with gentle gesture video',
    metaphorQuery: 'two hands meeting in warm sunlight close up video',
  },
  {
    conceptKey: 'courage',
    description: 'A person advances despite visible uncertainty and personal risk.',
    literalQuery: 'person standing firm before difficult challenge video',
    actionQuery: 'person taking first step onto high narrow path video',
    metaphorQuery: 'small flame holding steady in strong wind video',
  },
  {
    conceptKey: 'fear',
    description: 'An uncertain threat creates alert stillness and a desire to retreat.',
    literalQuery: 'anxious person watching dark hallway cinematic video',
    actionQuery: 'person backing away from unseen danger tense video',
    metaphorQuery: 'moving shadow crossing doorway suspenseful video',
  },
  {
    conceptKey: 'freedom',
    description: 'Open movement replaces restraint and restores personal possibility.',
    literalQuery: 'person standing in vast open landscape arms raised video',
    actionQuery: 'person running freely across wide field golden hour video',
    metaphorQuery: 'birds soaring above mountains clear sky video',
  },
  {
    conceptKey: 'regret',
    description: 'A person looks back on a choice that can no longer be changed.',
    literalQuery: 'reflective person alone after difficult decision video',
    actionQuery: 'person turning back toward closed door slowly video',
    metaphorQuery: 'footprints ending at receding tide cinematic video',
  },
  {
    conceptKey: 'resilience',
    description: 'Recovery follows hardship through steady effort and renewed balance.',
    literalQuery: 'person rebuilding damaged workspace determined video',
    actionQuery: 'athlete rising after fall and continuing forward video',
    metaphorQuery: 'green plant growing through cracked concrete video',
  },
  {
    conceptKey: 'betrayal',
    description: 'Broken trust creates distance between formerly close companions.',
    literalQuery: 'friends turning away after tense revelation video',
    actionQuery: 'person discovering concealed message and withdrawing video',
    metaphorQuery: 'cracked mirror separating two reflections video',
  },
  {
    conceptKey: 'friendship',
    description: 'Companions share mutual support through an ordinary moment together.',
    literalQuery: 'close friends laughing together outdoors candid video',
    actionQuery: 'friends helping each other complete difficult task video',
    metaphorQuery: 'two lanterns glowing together in evening dark video',
  },
  {
    conceptKey: 'ambition',
    description: 'Focused effort reaches toward a demanding and distant goal.',
    literalQuery: 'determined person planning goals at desk video',
    actionQuery: 'person climbing long staircase toward skyline video',
    metaphorQuery: 'mountain summit above clouds at sunrise video',
  },
  {
    conceptKey: 'sacrifice',
    description: 'Someone willingly gives up something valued for a greater need.',
    literalQuery: 'person handing over valued possession solemn video',
    actionQuery: 'person stepping aside so another can move forward video',
    metaphorQuery: 'candle melting while lighting dark room video',
  },
  {
    conceptKey: 'justice',
    description: 'Fairness is restored through accountability and balanced judgment.',
    literalQuery: 'balanced scales in formal chamber close up video',
    actionQuery: 'people presenting evidence across a table video',
    metaphorQuery: 'sunlight dividing shadow into equal halves video',
  },
  {
    conceptKey: 'grief',
    description: 'Deep sorrow is carried quietly after an irreversible absence.',
    literalQuery: 'grieving person sitting quietly near window video',
    actionQuery: 'person placing flowers at empty memorial video',
    metaphorQuery: 'rain running down dark window slow motion video',
  },
  {
    conceptKey: 'wonder',
    description: 'An unexpected sight inspires absorbed curiosity and open amazement.',
    literalQuery: 'person gazing upward in amazement cinematic video',
    actionQuery: 'person exploring glowing natural cavern curious video',
    metaphorQuery: 'night sky stars reflected in still lake video',
  },
  {
    conceptKey: 'homecoming',
    description: 'A familiar place welcomes someone back after a long absence.',
    literalQuery: 'traveler arriving at familiar home warm evening video',
    actionQuery: 'person walking up path toward welcoming doorway video',
    metaphorQuery: 'porch light glowing at dusk through falling snow video',
  },
]

interface EmbeddingSession {
  run(text: string, options: { mean_pool: true; normalize: true }): Promise<unknown>
}

interface RpcClient {
  rpc(name: string, arguments_: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export class VisualConceptSeedIndexError extends Error {}

export async function seedVisualConcepts(
  dependencies: { session: EmbeddingSession; client: RpcClient },
  indexInput: unknown,
): Promise<{ seeded: 1; model: 'gte-small'; conceptKey: string; index: number; nextIndex: number | null }> {
  const index = typeof indexInput === 'number'
    ? indexInput
    : typeof indexInput === 'string' && /^(?:0|[1-9]\d*)$/.test(indexInput)
    ? Number(indexInput)
    : Number.NaN
  if (!Number.isInteger(index) || index < 0 || index >= VISUAL_CONCEPT_SEEDS.length) {
    throw new VisualConceptSeedIndexError('invalid visual concept seed index')
  }

  const seed = VISUAL_CONCEPT_SEEDS[index]
  const embedding = assertEmbedding(await dependencies.session.run(
    seed.description,
    { mean_pool: true, normalize: true },
  ))
  const row = {
    concept_key: seed.conceptKey,
    description: seed.description,
    literal_query: seed.literalQuery,
    action_query: seed.actionQuery,
    metaphor_query: seed.metaphorQuery,
    embedding,
    enabled: true,
  }

  const result = await dependencies.client.rpc('upsert_visual_concepts', { p_concepts: [row] })
  if (result.error !== null || result.data !== 1) {
    throw new Error('visual concept seed failed')
  }

  return {
    seeded: 1,
    model: 'gte-small',
    conceptKey: seed.conceptKey,
    index,
    nextIndex: index + 1 < VISUAL_CONCEPT_SEEDS.length ? index + 1 : null,
  }
}
