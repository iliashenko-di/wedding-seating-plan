import type { GuestGroup, ProjectState, Seat, SeatingTable, Side, TableShape } from './types'

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']
export const MAX_GUESTS = 300
export const MAX_TABLES = 50
export const MAX_SEATS = 30
export const GRID = 20
export const MIN_TABLE_WIDTH = 100
export const MAX_TABLE_WIDTH = 600
export const MIN_TABLE_HEIGHT = 80
export const MAX_TABLE_HEIGHT = 400
export const GROUP_COLORS = ['#3b82f6', '#ef8f35', '#8b5cf6', '#14a76c', '#e0527d', '#0ea5a4', '#b7791f', '#64748b', '#dc2626', '#7c3aed', '#65a30d', '#0891b2']

export const emptyProject = (): ProjectState => ({
  version: 1,
  eventName: '',
  guests: [],
  guestGroups: [],
  tables: [],
})

export function uid(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`
}

export function tableSize(table: SeatingTable) {
  if (typeof table.width === 'number' && typeof table.height === 'number') {
    return { width: table.width, height: table.height }
  }
  if (table.shape === 'circle') return { width: 150, height: 150 }
  const long = Math.max(table.sideSeats.top, table.sideSeats.bottom)
  const short = Math.max(table.sideSeats.left, table.sideSeats.right)
  return {
    width: Math.max(180, 90 + long * 52),
    height: Math.max(110, 70 + short * 48),
  }
}

export function sideGeometry(table: SeatingTable) {
  const { width, height } = tableSize(table)
  const angle = table.rotation * Math.PI / 180
  const center = { x: table.x + width / 2, y: table.y + height / 2 }
  const local: Record<Side, { x: number; y: number; nx: number; ny: number; tx: number; ty: number; halfLength: number }> = {
    top: { x: 0, y: -height / 2, nx: 0, ny: -1, tx: 1, ty: 0, halfLength: width / 2 },
    right: { x: width / 2, y: 0, nx: 1, ny: 0, tx: 0, ty: 1, halfLength: height / 2 },
    bottom: { x: 0, y: height / 2, nx: 0, ny: 1, tx: -1, ty: 0, halfLength: width / 2 },
    left: { x: -width / 2, y: 0, nx: -1, ny: 0, tx: 0, ty: -1, halfLength: height / 2 },
  }
  return Object.fromEntries(SIDES.map((side) => {
    const point = local[side]
    return [side, {
      x: center.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
      y: center.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
      nx: point.nx * Math.cos(angle) - point.ny * Math.sin(angle),
      ny: point.nx * Math.sin(angle) + point.ny * Math.cos(angle),
      tx: point.tx * Math.cos(angle) - point.ty * Math.sin(angle),
      ty: point.tx * Math.sin(angle) + point.ty * Math.cos(angle),
      halfLength: point.halfLength,
    }]
  })) as Record<Side, { x: number; y: number; nx: number; ny: number; tx: number; ty: number; halfLength: number }>
}

export function findSnapCandidate(moving: SeatingTable, tables: SeatingTable[], threshold = 34) {
  if (moving.shape !== 'rectangle') return undefined
  const movingSides = sideGeometry(moving)
  let best: { other: SeatingTable; side: Side; otherSide: Side; dx: number; dy: number; distance: number; offset: number } | undefined
  for (const other of tables) {
    if (other.id === moving.id || other.shape !== 'rectangle' || (moving.groupId && moving.groupId === other.groupId)) continue
    const otherSides = sideGeometry(other)
    for (const side of SIDES) {
      if (moving.hiddenSides.includes(side)) continue
      for (const otherSide of SIDES) {
        if (other.hiddenSides.includes(otherSide)) continue
        const normalDot = movingSides[side].nx * otherSides[otherSide].nx + movingSides[side].ny * otherSides[otherSide].ny
        if (normalDot > -0.999) continue
        const relativeX = movingSides[side].x - otherSides[otherSide].x
        const relativeY = movingSides[side].y - otherSides[otherSide].y
        const rawOffset = relativeX * otherSides[otherSide].tx + relativeY * otherSides[otherSide].ty
        const offset = Math.max(-otherSides[otherSide].halfLength, Math.min(otherSides[otherSide].halfLength, rawOffset))
        const targetX = otherSides[otherSide].x + otherSides[otherSide].tx * offset
        const targetY = otherSides[otherSide].y + otherSides[otherSide].ty * offset
        const dx = targetX - movingSides[side].x
        const dy = targetY - movingSides[side].y
        const distance = Math.hypot(dx, dy)
        if (distance < threshold && (!best || distance < best.distance)) {
          best = { other, side, otherSide, dx, dy, distance, offset }
        }
      }
    }
  }
  return best
}

export function componentTableIds(tables: SeatingTable[], tableId: string) {
  const ids = new Set([tableId])
  let changed = true
  while (changed) {
    changed = false
    for (const table of tables) {
      const parentId = table.attachedTo?.tableId
      if (parentId && (ids.has(table.id) || ids.has(parentId))) {
        if (!ids.has(table.id)) { ids.add(table.id); changed = true }
        if (!ids.has(parentId)) { ids.add(parentId); changed = true }
      }
    }
  }
  return ids
}

export function descendantTableIds(tables: SeatingTable[], tableId: string) {
  const ids = new Set([tableId])
  let changed = true
  while (changed) {
    changed = false
    for (const table of tables) {
      if (table.attachedTo && ids.has(table.attachedTo.tableId) && !ids.has(table.id)) {
        ids.add(table.id)
        changed = true
      }
    }
  }
  return ids
}

export function rebuildConnections(tables: SeatingTable[]) {
  const hidden = new Map<string, Set<Side>>()
  for (const table of tables) hidden.set(table.id, new Set())
  for (const table of tables) {
    if (!table.attachedTo || !hidden.has(table.attachedTo.tableId)) continue
    hidden.get(table.id)!.add(table.attachedTo.ownSide)
    hidden.get(table.attachedTo.tableId)!.add(table.attachedTo.targetSide)
  }
  const visited = new Set<string>()
  const groups = new Map<string, string | undefined>()
  for (const table of tables) {
    if (visited.has(table.id)) continue
    const component = componentTableIds(tables, table.id)
    component.forEach((id) => visited.add(id))
    const groupId = component.size > 1 ? table.groupId || uid('group') : undefined
    component.forEach((id) => groups.set(id, groupId))
  }
  return tables.map((table) => ({
    ...table,
    groupId: groups.get(table.id),
    hiddenSides: [...(hidden.get(table.id) || [])],
  }))
}

export function placeAttachedTable(table: SeatingTable, target: SeatingTable, offset: number) {
  if (!table.attachedTo) return table
  const own = sideGeometry(table)[table.attachedTo.ownSide]
  const targetSide = sideGeometry(target)[table.attachedTo.targetSide]
  const safeOffset = Math.max(-targetSide.halfLength, Math.min(targetSide.halfLength, offset))
  const targetX = targetSide.x + targetSide.tx * safeOffset
  const targetY = targetSide.y + targetSide.ty * safeOffset
  return {
    ...table,
    x: table.x + targetX - own.x,
    y: table.y + targetY - own.y,
    attachedTo: { ...table.attachedTo, offset: safeOffset },
  }
}

export function realignAttachments(tables: SeatingTable[]) {
  let result = [...tables]
  for (let pass = 0; pass < result.length; pass += 1) {
    result = result.map((table) => {
      if (!table.attachedTo) return table
      const target = result.find((item) => item.id === table.attachedTo!.tableId)
      return target ? placeAttachedTable(table, target, table.attachedTo.offset) : { ...table, attachedTo: undefined }
    })
  }
  return rebuildConnections(result)
}

export function slideAttachedTable(tables: SeatingTable[], tableId: string, desiredX: number, desiredY: number) {
  const table = tables.find((item) => item.id === tableId)
  if (!table?.attachedTo) return tables
  const target = tables.find((item) => item.id === table.attachedTo!.tableId)
  if (!target) return tables
  const desired = { ...table, x: desiredX, y: desiredY }
  const own = sideGeometry(desired)[table.attachedTo.ownSide]
  const targetSide = sideGeometry(target)[table.attachedTo.targetSide]
  const offset = (own.x - targetSide.x) * targetSide.tx + (own.y - targetSide.y) * targetSide.ty
  const updated = tables.map((item) => item.id === tableId
    ? { ...item, attachedTo: { ...item.attachedTo!, offset } }
    : item)
  return realignAttachments(updated)
}

export function getSeats(table: SeatingTable): Seat[] {
  const { width, height } = tableSize(table)
  if (table.shape === 'circle') {
    return Array.from({ length: table.circleSeats }, (_, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / table.circleSeats
      return {
        id: `circle-${i}`,
        number: i + 1,
        x: width / 2 + Math.cos(angle) * (width / 2 + 29),
        y: height / 2 + Math.sin(angle) * (height / 2 + 29),
      }
    })
  }

  const seats: Seat[] = []
  let number = 1
  const addSide = (side: Side, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const ratio = (i + 1) / (count + 1)
      const seat = side === 'top'
        ? { x: ratio * width, y: -31 }
        : side === 'right'
          ? { x: width + 31, y: ratio * height }
          : side === 'bottom'
            ? { x: width - ratio * width, y: height + 31 }
            : { x: -31, y: height - ratio * height }
      seats.push({ id: `${side}-${i}`, number, side, ...seat })
      number += 1
    }
  }
  SIDES.forEach((side) => addSide(side, table.sideSeats[side]))
  return seats
}

export function createTable(
  index: number,
  shape: TableShape = 'rectangle',
  x = 300,
  y = 220,
): SeatingTable {
  return {
    id: uid('table'),
    name: `Стол ${index}`,
    shape,
    x,
    y,
    rotation: 0,
    width: shape === 'circle' ? 150 : 246,
    height: shape === 'circle' ? 150 : 118,
    sideSeats: { top: 3, right: 1, bottom: 3, left: 1 },
    circleSeats: 8,
    assignments: {},
    approvedSeats: {},
    hiddenSides: [],
  }
}

export function seatedGuestIds(project: ProjectState) {
  return new Set(project.tables.flatMap((table) => Object.values(table.assignments)))
}

export function assignGuest(project: ProjectState, guestId: string, tableId: string, seatId: string) {
  const tables = project.tables.map((table) => {
    const assignments = { ...table.assignments }
    const approvedSeats = { ...(table.approvedSeats || {}) }
    for (const [key, value] of Object.entries(assignments)) {
      if (value === guestId) {
        delete assignments[key]
        delete approvedSeats[key]
      }
    }
    return { ...table, assignments, approvedSeats }
  })
  const target = tables.find((table) => table.id === tableId)
  if (!target) return project
  const displaced = target.assignments[seatId]
  if (displaced) {
    const previous = project.tables.find((table) =>
      Object.values(table.assignments).includes(guestId),
    )
    const previousSeat = previous
      ? Object.entries(previous.assignments).find(([, id]) => id === guestId)?.[0]
      : undefined
    if (previous && previousSeat) {
      const previousTarget = tables.find((table) => table.id === previous.id)!
      previousTarget.assignments[previousSeat] = displaced
      delete previousTarget.approvedSeats[previousSeat]
    }
  }
  target.assignments[seatId] = guestId
  delete target.approvedSeats[seatId]
  return { ...project, tables }
}

export function resetUnapprovedGuests(project: ProjectState) {
  return {
    ...project,
    tables: project.tables.map((table) => {
      const assignments = Object.fromEntries(
        Object.entries(table.assignments).filter(([seatId]) => !!table.approvedSeats?.[seatId]),
      )
      const approvedSeats = Object.fromEntries(
        Object.entries(table.approvedSeats || {}).filter(([seatId, approved]) => approved && !!assignments[seatId]),
      )
      return { ...table, assignments, approvedSeats }
    }),
  }
}

function seatCollection(table: SeatingTable, side?: Side) {
  const prefix = side ? `${side}-` : 'circle-'
  const count = side ? table.sideSeats[side] : table.circleSeats
  return { prefix, count }
}

function reindexSeats(table: SeatingTable, side: Side | undefined, removeIndices: number[]) {
  const remove = new Set(removeIndices)
  const { prefix, count } = seatCollection(table, side)
  const assignments: Record<string, string> = {}
  const approvedSeats: Record<string, boolean> = {}

  const mapSeatId = (seatId: string) => {
    if (!seatId.startsWith(prefix)) return seatId
    const index = Number(seatId.slice(prefix.length))
    if (!Number.isInteger(index) || index < 0 || index >= count || remove.has(index)) return undefined
    const removedBefore = removeIndices.filter((item) => item < index).length
    return `${prefix}${index - removedBefore}`
  }

  for (const [seatId, guestId] of Object.entries(table.assignments)) {
    const nextId = mapSeatId(seatId)
    if (nextId) assignments[nextId] = guestId
  }
  for (const [seatId, approved] of Object.entries(table.approvedSeats || {})) {
    const nextId = mapSeatId(seatId)
    if (nextId && approved) approvedSeats[nextId] = approved
  }

  return { assignments, approvedSeats }
}

export function resizeSeatsWouldRemoveGuests(table: SeatingTable, targetCount: number, side?: Side) {
  const { prefix, count } = seatCollection(table, side)
  const safeTarget = Math.max(0, Math.min(MAX_SEATS, targetCount))
  const removeCount = Math.max(0, count - safeTarget)
  if (!removeCount) return []
  const indices = Array.from({ length: count }, (_, index) => index)
  const empty = indices.filter((index) => !table.assignments[`${prefix}${index}`]).sort((a, b) => b - a)
  const occupied = indices.filter((index) => table.assignments[`${prefix}${index}`]).sort((a, b) => b - a)
  const removeIndices = [...empty, ...occupied].slice(0, removeCount)
  return removeIndices.map((index) => table.assignments[`${prefix}${index}`]).filter((guestId): guestId is string => !!guestId)
}

export function resizeSeats(table: SeatingTable, targetCount: number, side?: Side) {
  const { prefix, count } = seatCollection(table, side)
  const safeTarget = Math.max(0, Math.min(MAX_SEATS, targetCount))
  if (safeTarget >= count) {
    return side
      ? { ...table, sideSeats: { ...table.sideSeats, [side]: safeTarget } }
      : { ...table, circleSeats: safeTarget }
  }
  const removeCount = count - safeTarget
  const indices = Array.from({ length: count }, (_, index) => index)
  const empty = indices.filter((index) => !table.assignments[`${prefix}${index}`]).sort((a, b) => b - a)
  const occupied = indices.filter((index) => table.assignments[`${prefix}${index}`]).sort((a, b) => b - a)
  const removeIndices = [...empty, ...occupied].slice(0, removeCount).sort((a, b) => a - b)
  const reindexed = reindexSeats(table, side, removeIndices)
  return side
    ? { ...table, sideSeats: { ...table.sideSeats, [side]: safeTarget }, ...reindexed }
    : { ...table, circleSeats: safeTarget, ...reindexed }
}

export function removeEmptySeat(table: SeatingTable, seatId: string) {
  if (table.assignments[seatId]) return table
  const circle = /^circle-(\d+)$/.exec(seatId)
  if (circle) {
    const index = Number(circle[1])
    if (!Number.isInteger(index) || index < 0 || index >= table.circleSeats) return table
    const reindexed = reindexSeats(table, undefined, [index])
    return { ...table, circleSeats: Math.max(0, table.circleSeats - 1), ...reindexed }
  }
  const sideMatch = /^(top|right|bottom|left)-(\d+)$/.exec(seatId)
  if (!sideMatch) return table
  const side = sideMatch[1] as Side
  const index = Number(sideMatch[2])
  if (!Number.isInteger(index) || index < 0 || index >= table.sideSeats[side]) return table
  const reindexed = reindexSeats(table, side, [index])
  return { ...table, sideSeats: { ...table.sideSeats, [side]: Math.max(0, table.sideSeats[side] - 1) }, ...reindexed }
}

export function validateProject(value: unknown): value is ProjectState {
  if (!value || typeof value !== 'object') return false
  const p = value as ProjectState
  return p.version === 1 && typeof p.eventName === 'string' &&
    Array.isArray(p.guests) && Array.isArray(p.tables) &&
    (!('guestGroups' in p) || Array.isArray(p.guestGroups)) &&
    p.guests.every((g) => g && typeof g.id === 'string' && typeof g.name === 'string') &&
    p.tables.every((t) => t && typeof t.id === 'string' && typeof t.name === 'string' &&
      ['rectangle', 'oval', 'circle'].includes(t.shape) &&
      typeof t.x === 'number' && typeof t.y === 'number' &&
      t.assignments && typeof t.assignments === 'object')
}

export function normalizeProject(project: ProjectState): ProjectState {
  const guestGroups = Array.isArray(project.guestGroups)
    ? project.guestGroups
        .filter((group): group is GuestGroup => !!group && typeof group.id === 'string' && typeof group.name === 'string')
        .map((group, index) => ({
          id: group.id,
          name: group.name.slice(0, 40),
          color: typeof group.color === 'string' ? group.color : GROUP_COLORS[index % GROUP_COLORS.length],
        }))
    : []
  const groupIds = new Set(guestGroups.map((group) => group.id))
  const guests = project.guests.map((guest) => ({
    ...guest,
    groupId: guest.groupId && groupIds.has(guest.groupId) ? guest.groupId : undefined,
  }))
  const tables = project.tables.map((table) => {
    const fallback = tableSize(table)
    return {
      ...table,
      width: typeof table.width === 'number' ? table.width : fallback.width,
      height: typeof table.height === 'number' ? table.height : fallback.height,
      approvedSeats: table.approvedSeats && typeof table.approvedSeats === 'object' ? table.approvedSeats : {},
      groupId: undefined,
      attachedTo: undefined,
      hiddenSides: [],
    }
  })
  return { ...project, guests, guestGroups, tables }
}

export function createTemplate(
  kind: 'rows' | 'u' | 'long',
  count: number,
  shape: TableShape,
): SeatingTable[] {
  const safeCount = Math.max(1, Math.min(MAX_TABLES, count))
  if (kind === 'rows') {
    const cols = Math.ceil(Math.sqrt(safeCount))
    return Array.from({ length: safeCount }, (_, i) =>
      createTable(i + 1, shape, 180 + (i % cols) * 330, 160 + Math.floor(i / cols) * 250),
    )
  }
  if (kind === 'long') {
    return Array.from({ length: safeCount }, (_, i) =>
      createTable(i + 1, 'rectangle', 180 + i * 270, 260),
    )
  }
  const bottomCount = Math.max(1, safeCount - 2)
  return Array.from({ length: safeCount }, (_, i) => {
    if (i === 0) return { ...createTable(1, 'rectangle', 180, 160), rotation: 90 }
    if (i === safeCount - 1) {
      return { ...createTable(i + 1, 'rectangle', 180 + bottomCount * 270, 160), rotation: 90 }
    }
    return createTable(i + 1, 'rectangle', 180 + (i - 1) * 270, 420)
  })
}

export function visibleSeatCount(table: SeatingTable) {
  return getSeats(table).filter((seat) => !seat.side || !table.hiddenSides.includes(seat.side)).length
}
