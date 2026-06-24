import type { ProjectState, Seat, SeatingTable, Side, TableShape } from './types'

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']
export const MAX_GUESTS = 300
export const MAX_TABLES = 50
export const MAX_SEATS = 30
export const GRID = 20

export const emptyProject = (): ProjectState => ({
  version: 1,
  eventName: '',
  guests: [],
  tables: [],
})

export function uid(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`
}

export function tableSize(table: SeatingTable) {
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
  const local: Record<Side, { x: number; y: number; nx: number; ny: number }> = {
    top: { x: 0, y: -height / 2, nx: 0, ny: -1 },
    right: { x: width / 2, y: 0, nx: 1, ny: 0 },
    bottom: { x: 0, y: height / 2, nx: 0, ny: 1 },
    left: { x: -width / 2, y: 0, nx: -1, ny: 0 },
  }
  return Object.fromEntries(SIDES.map((side) => {
    const point = local[side]
    return [side, {
      x: center.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
      y: center.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
      nx: point.nx * Math.cos(angle) - point.ny * Math.sin(angle),
      ny: point.nx * Math.sin(angle) + point.ny * Math.cos(angle),
    }]
  })) as Record<Side, { x: number; y: number; nx: number; ny: number }>
}

export function findSnapCandidate(moving: SeatingTable, tables: SeatingTable[], threshold = 34) {
  if (moving.shape !== 'rectangle') return undefined
  const movingSides = sideGeometry(moving)
  let best: { other: SeatingTable; side: Side; otherSide: Side; dx: number; dy: number; distance: number } | undefined
  for (const other of tables) {
    if (other.id === moving.id || other.shape !== 'rectangle') continue
    const delta = Math.abs((((moving.rotation - other.rotation) % 180) + 180) % 180)
    if (delta > 0.001) continue
    const otherSides = sideGeometry(other)
    for (const side of SIDES) {
      if (moving.hiddenSides.includes(side)) continue
      for (const otherSide of SIDES) {
        if (other.hiddenSides.includes(otherSide)) continue
        const normalDot = movingSides[side].nx * otherSides[otherSide].nx + movingSides[side].ny * otherSides[otherSide].ny
        if (normalDot > -0.999) continue
        const dx = otherSides[otherSide].x - movingSides[side].x
        const dy = otherSides[otherSide].y - movingSides[side].y
        const distance = Math.hypot(dx, dy)
        if (distance < threshold && (!best || distance < best.distance)) {
          best = { other, side, otherSide, dx, dy, distance }
        }
      }
    }
  }
  return best
}

export function rebuildGroupHiddenSides(tables: SeatingTable[], groupId: string) {
  const group = tables.filter((table) => table.groupId === groupId)
  if (group.length < 2) {
    return tables.map((table) => table.groupId === groupId ? { ...table, groupId: undefined, hiddenSides: [] } : table)
  }
  return tables.map((table) => {
    if (table.groupId !== groupId) return table
    const geometry = sideGeometry(table)
    const hiddenSides = SIDES.filter((side) => group.some((other) => {
      if (other.id === table.id) return false
      const otherGeometry = sideGeometry(other)
      return SIDES.some((otherSide) => {
        const dot = geometry[side].nx * otherGeometry[otherSide].nx + geometry[side].ny * otherGeometry[otherSide].ny
        return dot < -0.999 && Math.hypot(geometry[side].x - otherGeometry[otherSide].x, geometry[side].y - otherGeometry[otherSide].y) < 2
      })
    }))
    return { ...table, hiddenSides }
  })
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
    sideSeats: { top: 3, right: 1, bottom: 3, left: 1 },
    circleSeats: 8,
    assignments: {},
    hiddenSides: [],
  }
}

export function seatedGuestIds(project: ProjectState) {
  return new Set(project.tables.flatMap((table) => Object.values(table.assignments)))
}

export function assignGuest(project: ProjectState, guestId: string, tableId: string, seatId: string) {
  const tables = project.tables.map((table) => {
    const assignments = { ...table.assignments }
    for (const [key, value] of Object.entries(assignments)) {
      if (value === guestId) delete assignments[key]
    }
    return { ...table, assignments }
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
    }
  }
  target.assignments[seatId] = guestId
  return { ...project, tables }
}

export function validateProject(value: unknown): value is ProjectState {
  if (!value || typeof value !== 'object') return false
  const p = value as ProjectState
  return p.version === 1 && typeof p.eventName === 'string' &&
    Array.isArray(p.guests) && Array.isArray(p.tables) &&
    p.guests.every((g) => g && typeof g.id === 'string' && typeof g.name === 'string') &&
    p.tables.every((t) => t && typeof t.id === 'string' && typeof t.name === 'string' &&
      ['rectangle', 'oval', 'circle'].includes(t.shape) &&
      typeof t.x === 'number' && typeof t.y === 'number' &&
      t.assignments && typeof t.assignments === 'object')
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
