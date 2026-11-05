import { describe, expect, it } from 'vitest'
import { inferMissionIntent } from '../mission-intent'

describe('mission intent inference', () => {
  it('infers a strong specialist requirement from the task title', () => {
    const result = inferMissionIntent('Fix boss AI phase transitions')
    expect(result.requirements.requiredCapabilities).toContain('enemy-ai')
    expect(result.evidence).toContainEqual(expect.objectContaining({ capability: 'enemy-ai', source: 'title' }))
  })

  it('infers repository/build ownership from CI and Unity meta language', () => {
    const result = inferMissionIntent('Repair CI and Unity meta handling')
    expect(result.requirements.requiredCapabilities).toContain('build-repository')
  })

  it('treats description-only signals as preferences rather than hard gates', () => {
    const result = inferMissionIntent('Polish the feature', 'Run QA and regression tests after implementation.')
    expect(result.requirements.requiredCapabilities).toEqual([])
    expect(result.requirements.preferredCapabilities).toEqual(expect.arrayContaining(['qa-release', 'testing-review']))
  })

  it('can identify multiple explicitly named domains in one title', () => {
    const result = inferMissionIntent('Fix combat camera shake during beam clashes')
    expect(result.requirements.requiredCapabilities).toEqual(expect.arrayContaining(['combat-systems', 'vfx-camera']))
  })

  it('recognizes construction estimating intent', () => {
    const result = inferMissionIntent('Create material takeoff and estimate')
    expect(result.requirements.requiredCapabilities).toContain('construction-estimating')
  })
})
