export interface NoulQ {
  type: "noul"
  instructions: string | object
  criteria?: { true?: string | object; false?: string | object } | null
}

export interface ChoiceQ {
  type: "choice"
  instructions: string | object
  criteria: Record<string, string | object>
}

export interface ScoreQ {
  type: "score"
  instructions: string | object
  criteria: (string | object)[]
}

export function noul(instructions: string | object, yes?: string | object, no?: string | object): NoulQ {
  const q: NoulQ = { type: "noul", instructions }
  const criteria: { true?: string | object; false?: string | object } = {}
  if (yes !== undefined) criteria.true = yes
  if (no !== undefined) criteria.false = no
  if (Object.keys(criteria).length > 0) q.criteria = criteria
  return q
}

export function choice(instructions: string | object, criteria: Record<string, string | object>): ChoiceQ {
  return { type: "choice", instructions, criteria }
}

export function score(instructions: string | object, levels: (string | object)[]): ScoreQ {
  return { type: "score", instructions, criteria: levels }
}
