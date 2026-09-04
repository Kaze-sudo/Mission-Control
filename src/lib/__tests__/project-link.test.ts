import { describe, expect, it } from 'vitest'
import {
  parseProjectQueryParam,
  projectCommandHref,
  projectCommandPath,
  resolveProjectSelection,
} from '@/lib/project-link'

const projects = [
  { id: 1, name: 'AgentOS Operations' },
  { id: 8, name: 'Game' },
]

describe('projectCommandHref / projectCommandPath', () => {
  it('produces the /command deep-link path with an immutable project id', () => {
    expect(projectCommandPath()).toBe('/command')
    expect(projectCommandHref(8)).toBe('/command?project=8')
  })
})

describe('parseProjectQueryParam', () => {
  it('accepts positive integer ids', () => {
    expect(parseProjectQueryParam('8')).toBe(8)
    expect(parseProjectQueryParam(' 3 ')).toBe(3)
  })

  it('returns null for absent or malformed values', () => {
    expect(parseProjectQueryParam(null)).toBeNull()
    expect(parseProjectQueryParam(undefined)).toBeNull()
    expect(parseProjectQueryParam('')).toBeNull()
    expect(parseProjectQueryParam('abc')).toBeNull()
    expect(parseProjectQueryParam('1.5')).toBeNull()
    expect(parseProjectQueryParam('-3')).toBeNull()
    expect(parseProjectQueryParam('0')).toBeNull()
  })
})

describe('resolveProjectSelection', () => {
  it('selects the requested project when it exists', () => {
    expect(resolveProjectSelection({ rawParam: '8', projects })).toEqual({
      selectedId: 8,
      requestedInvalid: false,
      requestedId: 8,
    })
  })

  it('falls back to the first project when the requested id is missing', () => {
    expect(resolveProjectSelection({ rawParam: '999', projects })).toEqual({
      selectedId: 1,
      requestedInvalid: true,
      requestedId: 999,
    })
  })

  it('falls back to the first project when no parameter is present', () => {
    expect(resolveProjectSelection({ rawParam: null, projects })).toEqual({
      selectedId: 1,
      requestedInvalid: false,
      requestedId: null,
    })
  })

  it('honors an explicit fallback id', () => {
    expect(resolveProjectSelection({ rawParam: '999', projects, fallbackId: 8 })).toEqual({
      selectedId: 8,
      requestedInvalid: true,
      requestedId: 999,
    })
  })

  it('degrades safely with no projects at all', () => {
    expect(resolveProjectSelection({ rawParam: '5', projects: [] })).toEqual({
      selectedId: null,
      requestedInvalid: true,
      requestedId: 5,
    })
    expect(resolveProjectSelection({ rawParam: null, projects: [] })).toEqual({
      selectedId: null,
      requestedInvalid: false,
      requestedId: null,
    })
  })

  it('treats a malformed parameter like an absent one', () => {
    expect(resolveProjectSelection({ rawParam: 'project-name', projects })).toEqual({
      selectedId: 1,
      requestedInvalid: false,
      requestedId: null,
    })
  })
})
