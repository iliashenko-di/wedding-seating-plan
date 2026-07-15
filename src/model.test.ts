import { describe, expect, it } from 'vitest'
import {
  assignGuest, createTable, createTemplate, emptyProject, findSnapCandidate, getSeats,
  normalizeProject, placeAttachedTable, slideAttachedTable, tableSize, validateProject,
} from './model'

describe('места за столами', () => {
  it('нумерует прямоугольный стол по часовой стрелке, начиная сверху', () => {
    const table = createTable(1, 'rectangle')
    table.sideSeats = { top: 2, right: 1, bottom: 2, left: 1 }
    expect(getSeats(table).map((seat) => [seat.number, seat.side])).toEqual([
      [1, 'top'], [2, 'top'], [3, 'right'], [4, 'bottom'], [5, 'bottom'], [6, 'left'],
    ])
  })

  it('нумерует круглый стол начиная с верхнего места', () => {
    const table = createTable(1, 'circle')
    table.circleSeats = 4
    const seats = getSeats(table)
    expect(seats).toHaveLength(4)
    expect(seats[0].number).toBe(1)
    expect(seats[0].y).toBeLessThan(seats[1].y)
  })
})

describe('рассадка', () => {
  it('пересаживает гостя и меняет двух гостей местами', () => {
    const table = createTable(1)
    const [first, second] = getSeats(table)
    const project = {
      ...emptyProject(),
      guests: [{ id: 'a', name: 'Анна' }, { id: 'b', name: 'Борис' }],
      tables: [{ ...table, assignments: { [first.id]: 'a', [second.id]: 'b' } }],
    }
    const result = assignGuest(project, 'a', table.id, second.id)
    expect(result.tables[0].assignments[first.id]).toBe('b')
    expect(result.tables[0].assignments[second.id]).toBe('a')
  })

  it('снимает утверждение места при пересадке гостя', () => {
    const table = createTable(1)
    const [first, second] = getSeats(table)
    const project = {
      ...emptyProject(),
      guests: [{ id: 'a', name: 'Анна' }],
      tables: [{ ...table, assignments: { [first.id]: 'a' }, approvedSeats: { [first.id]: true } }],
    }
    const result = assignGuest(project, 'a', table.id, second.id)
    expect(result.tables[0].assignments[second.id]).toBe('a')
    expect(result.tables[0].approvedSeats[first.id]).toBeUndefined()
    expect(result.tables[0].approvedSeats[second.id]).toBeUndefined()
  })
})

describe('шаблоны и файлы проекта', () => {
  it('создаёт редактируемый шаблон нужного размера', () => {
    expect(createTemplate('rows', 7, 'oval')).toHaveLength(7)
    expect(createTemplate('long', 4, 'circle').every((table) => table.shape === 'rectangle')).toBe(true)
  })

  it('отклоняет повреждённый JSON', () => {
    expect(validateProject({ version: 1, eventName: '', guests: [], tables: [] })).toBe(true)
    expect(validateProject({ version: 1, guests: 'нет' })).toBe(false)
  })
})

describe('магнитное сцепление', () => {
  it('находит соприкасающиеся параллельные стороны', () => {
    const first = createTable(1, 'rectangle', 100, 100)
    const second = createTable(2, 'rectangle', 346, 100)
    const right = findSnapCandidate(first, [second])
    expect(right).toBeDefined()
    expect(right!.distance).toBe(0)
  })

  it('сцепляет столы перпендикулярно', () => {
    const target = createTable(1, 'rectangle', 100, 200)
    const moving = createTable(2, 'rectangle', 0, 0)
    moving.rotation = 90
    moving.attachedTo = { tableId: target.id, ownSide: 'right', targetSide: 'top', offset: 0 }
    const placed = placeAttachedTable(moving, target, 0)
    placed.attachedTo = undefined
    const snap = findSnapCandidate(placed, [target])
    expect(snap).toMatchObject({ side: 'right', otherSide: 'top' })
  })

  it('сцепляет перпендикулярный стол не только по центру длинной стороны', () => {
    const target = createTable(1, 'rectangle', 100, 200)
    target.width = 400
    const moving = createTable(2, 'rectangle', 0, 0)
    moving.rotation = 90
    moving.attachedTo = { tableId: target.id, ownSide: 'right', targetSide: 'top', offset: 140 }
    const placed = placeAttachedTable(moving, target, 140)
    placed.attachedTo = undefined
    const snap = findSnapCandidate({ ...placed, y: placed.y - 35 }, [target], 60)
    expect(snap).toMatchObject({ side: 'right', otherSide: 'top' })
    expect(snap!.offset).toBeGreaterThan(100)
  })

  it('двигает прикреплённый стол вдоль стороны', () => {
    const target = createTable(1, 'rectangle', 100, 200)
    const moving = createTable(2, 'rectangle', 0, 0)
    moving.rotation = 90
    moving.attachedTo = { tableId: target.id, ownSide: 'right', targetSide: 'top', offset: 0 }
    const placed = placeAttachedTable(moving, target, 0)
    const result = slideAttachedTable([target, placed], moving.id, placed.x + 70, placed.y)
    const shifted = result.find((table) => table.id === moving.id)!
    expect(shifted.attachedTo?.offset).toBeGreaterThan(0)
  })
})

describe('размер стола', () => {
  it('не зависит от количества посадочных мест', () => {
    const table = createTable(1)
    const before = tableSize(table)
    table.sideSeats.top = 10
    table.sideSeats.bottom = 10
    expect(tableSize(table)).toEqual(before)
  })

  it('добавляет размеры старому проекту без потери рассадки', () => {
    const table = createTable(1)
    table.assignments['top-0'] = 'guest-1'
    const legacyTable = { ...table } as Partial<typeof table>
    delete legacyTable.width
    delete legacyTable.height
    const migrated = normalizeProject({
      ...emptyProject(),
      guests: [{ id: 'guest-1', name: 'Анна' }],
      tables: [legacyTable as typeof table],
    })
    expect(migrated.tables[0].width).toBeGreaterThan(0)
    expect(migrated.tables[0].assignments['top-0']).toBe('guest-1')
  })

  it('превращает старые сцепленные столы в независимые и сохраняет группы гостей', () => {
    const first = createTable(1)
    const second = createTable(2)
    second.groupId = 'old-group'
    second.hiddenSides = ['left']
    second.attachedTo = { tableId: first.id, ownSide: 'left', targetSide: 'right', offset: 0 }
    const migrated = normalizeProject({
      ...emptyProject(),
      guestGroups: [{ id: 'friends', name: 'Друзья жениха', color: '#123456' }],
      guests: [{ id: 'guest-1', name: 'Анна', groupId: 'friends' }],
      tables: [first, second],
    })
    expect(migrated.guestGroups[0].name).toBe('Друзья жениха')
    expect(migrated.guests[0].groupId).toBe('friends')
    expect(migrated.tables[1].attachedTo).toBeUndefined()
    expect(migrated.tables[1].groupId).toBeUndefined()
    expect(migrated.tables[1].hiddenSides).toEqual([])
  })
})
