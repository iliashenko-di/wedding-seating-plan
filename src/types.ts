export type TableShape = 'rectangle' | 'oval' | 'circle'
export type Side = 'top' | 'right' | 'bottom' | 'left'

export interface Guest {
  id: string
  name: string
}

export interface SeatingTable {
  id: string
  name: string
  shape: TableShape
  x: number
  y: number
  rotation: number
  sideSeats: Record<Side, number>
  circleSeats: number
  assignments: Record<string, string>
  groupId?: string
  hiddenSides: Side[]
}

export interface ProjectState {
  version: 1
  eventName: string
  guests: Guest[]
  tables: SeatingTable[]
}

export interface Seat {
  id: string
  number: number
  side?: Side
  x: number
  y: number
}
