import { describe, expect, it } from 'vitest'
import { assignGuest, createTable, createTemplate, emptyProject, findSnapCandidate, getSeats, validateProject } from './model'

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
  it('находит соприкасающиеся стороны у столов с общим поворотом', () => {
    const first = createTable(1, 'rectangle', 100, 100)
    const second = createTable(2, 'rectangle', 100, 100)
    first.rotation = 15
    second.rotation = 15
    const right = findSnapCandidate(first, [second], 1000)
    expect(right).toBeDefined()
    expect(right!.distance).toBeGreaterThanOrEqual(0)
  })

  it('не сцепляет столы с разными углами', () => {
    const first = createTable(1, 'rectangle')
    const second = createTable(2, 'rectangle')
    second.rotation = 15
    expect(findSnapCandidate(first, [second], 1000)).toBeUndefined()
  })
})
