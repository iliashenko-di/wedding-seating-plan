import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Armchair, Check, ChevronLeft, ChevronRight, CirclePlus, Download, FileDown,
  FileUp, Grid2X2, Hand, Maximize2, Minus, MousePointer2, Plus, Redo2, RotateCcw,
  RotateCw, Search, Trash2, Undo2, Users, X,
} from 'lucide-react'
import { toPng } from 'html-to-image'
import {
  assignGuest, createTable, createTemplate, emptyProject,
  findSnapCandidate, getSeats, GRID, GROUP_COLORS, MAX_GUESTS, MAX_SEATS, MAX_TABLES, MAX_TABLE_HEIGHT,
  MAX_TABLE_WIDTH, MIN_TABLE_HEIGHT, MIN_TABLE_WIDTH, normalizeProject,
  removeEmptySeat, resetUnapprovedGuests, resizeSeats, resizeSeatsWouldRemoveGuests, seatedGuestIds, tableSize,
  uid, validateProject, visibleSeatCount,
} from './model'
import type { ProjectState, SeatingTable, Side, TableShape } from './types'

const STORAGE_KEY = 'wedding-seating-project-v1'
type Filter = 'all' | 'unseated' | 'seated'
type CanvasTool = 'select' | 'pan'
type SeatMenuState = { tableId: string; seatId: string; x: number; y: number }

function useProjectHistory(initial: ProjectState) {
  const [project, setProject] = useState(initial)
  const [past, setPast] = useState<ProjectState[]>([])
  const [future, setFuture] = useState<ProjectState[]>([])
  const dragStart = useRef<ProjectState | null>(null)

  const commit = (next: ProjectState | ((value: ProjectState) => ProjectState)) => {
    setProject((current) => {
      const value = typeof next === 'function' ? next(current) : next
      if (value === current) return current
      setPast((items) => [...items.slice(-79), current])
      setFuture([])
      return value
    })
  }
  const replace = (updater: (value: ProjectState) => ProjectState) => setProject(updater)
  const beginTransient = () => { dragStart.current = project }
  const endTransient = () => {
    if (dragStart.current && JSON.stringify(dragStart.current) !== JSON.stringify(project)) {
      setPast((items) => [...items.slice(-79), dragStart.current!])
      setFuture([])
    }
    dragStart.current = null
  }
  const undo = () => {
    if (!past.length) return
    const previous = past[past.length - 1]
    setPast((items) => items.slice(0, -1))
    setFuture((items) => [project, ...items])
    setProject(previous)
  }
  const redo = () => {
    if (!future.length) return
    const next = future[0]
    setFuture((items) => items.slice(1))
    setPast((items) => [...items, project])
    setProject(next)
  }
  const resetHistory = (value: ProjectState) => {
    setProject(value)
    setPast([])
    setFuture([])
  }
  return { project, commit, replace, undo, redo, canUndo: !!past.length, canRedo: !!future.length, beginTransient, endTransient, resetHistory }
}

function loadInitialProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return validateProject(parsed) ? normalizeProject(parsed) : emptyProject()
  } catch {
    return emptyProject()
  }
}

export default function App() {
  const history = useProjectHistory(loadInitialProject())
  const { project } = history
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [guestName, setGuestName] = useState('')
  const [groupName, setGroupName] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string>()
  const [zoom, setZoom] = useState(0.8)
  const [pan, setPan] = useState({ x: 40, y: 40 })
  const [tableDialog, setTableDialog] = useState(false)
  const [templateDialog, setTemplateDialog] = useState(false)
  const [toast, setToast] = useState('')
  const [seatMenu, setSeatMenu] = useState<SeatMenuState>()
  const [canvasTool, setCanvasTool] = useState<CanvasTool>('select')
  const [groupsTooltipHidden, setGroupsTooltipHidden] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | undefined>(undefined)
  const tableDrag = useRef<{ id: string; x: number; y: number; px: number; py: number; ids: string[] } | undefined>(undefined)
  const selectionDrag = useRef<{ startX: number; startY: number; additive: boolean } | undefined>(undefined)
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number }>()
  const selectionBoxRef = useRef<{ left: number; top: number; width: number; height: number } | undefined>(undefined)

  const seated = useMemo(() => seatedGuestIds(project), [project])
  const unapprovedSeatedCount = useMemo(() => project.tables.reduce((sum, table) =>
    sum + Object.entries(table.assignments).filter(([seatId]) => !table.approvedSeats?.[seatId]).length, 0), [project.tables])
  const groupById = useMemo(() => new Map(project.guestGroups.map((group) => [group.id, group])), [project.guestGroups])
  const selectedGroup = selectedGroupId ? project.guestGroups.find((group) => group.id === selectedGroupId) : undefined
  const groupStats = useMemo(() => {
    const counts = new Map(project.guestGroups.map((group) => [group.id, 0]))
    let ungrouped = 0
    for (const guest of project.guests) {
      if (guest.groupId && counts.has(guest.groupId)) counts.set(guest.groupId, (counts.get(guest.groupId) || 0) + 1)
      else ungrouped += 1
    }
    return {
      groups: project.guestGroups.map((group) => ({ ...group, count: counts.get(group.id) || 0 })),
      ungrouped,
    }
  }, [project.guestGroups, project.guests])
  const selectedTable = selectedTableIds.length === 1
    ? project.tables.find((table) => table.id === selectedTableIds[0])
    : undefined
  const totalSeats = project.tables.reduce((sum, table) => sum + visibleSeatCount(table), 0)
  const freeSeats = totalSeats - seated.size
  const exportBounds = useMemo(() => {
    if (!project.tables.length) return { minX: 0, minY: 0, width: 800, height: 600 }
    const bounds = project.tables.reduce((acc, table) => {
      const size = tableSize(table)
      return {
        minX: Math.min(acc.minX, table.x - 90),
        minY: Math.min(acc.minY, table.y - 90),
        maxX: Math.max(acc.maxX, table.x + size.width + 90),
        maxY: Math.max(acc.maxY, table.y + size.height + 90),
      }
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
    return {
      minX: bounds.minX,
      minY: bounds.minY,
      width: Math.max(800, bounds.maxX - bounds.minX),
      height: Math.max(600, bounds.maxY - bounds.minY),
    }
  }, [project.tables])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
  }, [project])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(id)
  }, [toast])

  useEffect(() => {
    if (!seatMenu) return
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.seat-menu-portal')) return
      setSeatMenu(undefined)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [seatMenu])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (editable) return
      const key = event.key.toLowerCase()
      if (!event.ctrlKey && !event.metaKey && !event.altKey && key === 'c') {
        event.preventDefault()
        setCanvasTool('select')
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && key === 'v') {
        event.preventDefault()
        setCanvasTool('pan')
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? history.redo() : history.undo()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        history.redo()
      }
      if (event.key === 'Escape') {
        setSelectedTableIds([])
        setSeatMenu(undefined)
      }
      if (event.key === 'Delete' && selectedTableIds.length) deleteTables(selectedTableIds)
      if (selectedTableIds.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const delta = event.shiftKey ? GRID * 5 : GRID
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
        moveSelected(selectedTableIds, dx, dy, true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  const showToast = (message: string) => setToast(message)

  const addGuest = () => {
    const name = guestName.trim()
    if (!name) return
    if (name.length > 50) return showToast('Имя должно быть не длиннее 50 символов')
    if (project.guests.length >= MAX_GUESTS) return showToast('Достигнут лимит: 300 гостей')
    history.commit({ ...project, guests: [...project.guests, { id: uid('guest'), name }] })
    setGuestName('')
  }

  const addGroup = () => {
    const name = groupName.trim()
    if (!name) return
    if (name.length > 40) return showToast('Название группы должно быть не длиннее 40 символов')
    const group = {
      id: uid('group'),
      name,
      color: GROUP_COLORS[project.guestGroups.length % GROUP_COLORS.length],
    }
    history.commit({ ...project, guestGroups: [...project.guestGroups, group] })
    setSelectedGroupId(group.id)
    setGroupName('')
  }

  const renameGroup = (groupId: string) => {
    const group = project.guestGroups.find((item) => item.id === groupId)
    if (!group) return
    const name = window.prompt('Название группы', group.name)?.trim()
    if (!name || name.length > 40) return
    history.commit({
      ...project,
      guestGroups: project.guestGroups.map((item) => item.id === groupId ? { ...item, name } : item),
    })
  }

  const removeGroup = (groupId: string) => {
    const group = project.guestGroups.find((item) => item.id === groupId)
    if (!group) return
    if (!window.confirm(`Удалить группу «${group.name}»? Гости останутся в списке без группы.`)) return
    history.commit({
      ...project,
      guestGroups: project.guestGroups.filter((item) => item.id !== groupId),
      guests: project.guests.map((guest) => guest.groupId === groupId ? { ...guest, groupId: undefined } : guest),
    })
    setSelectedGroupId((current) => current === groupId ? undefined : current)
  }

  const setGroupColor = (groupId: string, color: string) => {
    history.commit({
      ...project,
      guestGroups: project.guestGroups.map((group) => group.id === groupId ? { ...group, color } : group),
    })
  }

  const setGuestGroup = (guestId: string, groupId: string) => {
    history.commit({
      ...project,
      guests: project.guests.map((guest) => guest.id === guestId
        ? { ...guest, groupId: groupId || undefined }
        : guest),
    })
  }

  const editGuest = (guestId: string) => {
    const guest = project.guests.find((item) => item.id === guestId)
    if (!guest) return
    const name = window.prompt('Имя гостя', guest.name)?.trim()
    if (!name || name.length > 50) return
    history.commit({ ...project, guests: project.guests.map((item) => item.id === guestId ? { ...item, name } : item) })
  }

  const removeGuest = (guestId: string) => {
    const guest = project.guests.find((item) => item.id === guestId)
    if (!guest) return
    if (seated.has(guestId) && !window.confirm(`Гость «${guest.name}» уже рассажен. Удалить его и освободить место?`)) return
    history.commit({
      ...project,
      guests: project.guests.filter((item) => item.id !== guestId),
      tables: project.tables.map((table) => {
        const removedSeats = new Set(Object.entries(table.assignments).filter(([, id]) => id === guestId).map(([seatId]) => seatId))
        return {
          ...table,
          assignments: Object.fromEntries(Object.entries(table.assignments).filter(([, id]) => id !== guestId)),
          approvedSeats: Object.fromEntries(Object.entries(table.approvedSeats || {}).filter(([seatId]) => !removedSeats.has(seatId))),
        }
      }),
    })
    setSeatMenu(undefined)
  }

  const returnGuest = (guestId: string) => {
    history.commit({
      ...project,
      tables: project.tables.map((table) => ({
        ...table,
        assignments: Object.fromEntries(Object.entries(table.assignments).filter(([, id]) => id !== guestId)),
        approvedSeats: Object.fromEntries(Object.entries(table.approvedSeats || {}).filter(([seatId]) => table.assignments[seatId] !== guestId)),
      })),
    })
    setSeatMenu(undefined)
  }

  const resetAllGuests = () => {
    if (!seated.size) return showToast('На схеме пока нет рассаженных гостей')
    if (!window.confirm('Очистить все места и вернуть всех гостей в список?')) return
    history.commit({
      ...project,
      tables: project.tables.map((table) => ({ ...table, assignments: {}, approvedSeats: {} })),
    })
    setSeatMenu(undefined)
    showToast('Все гости возвращены в список')
  }

  const resetUnapprovedSeatedGuests = () => {
    if (!unapprovedSeatedCount) return showToast('Неутверждённых гостей на схеме нет')
    if (!window.confirm(`Вернуть в список неутверждённых гостей: ${unapprovedSeatedCount}? Утверждённые места останутся на схеме.`)) return
    history.commit(resetUnapprovedGuests(project))
    setSeatMenu(undefined)
    showToast('Неутверждённые гости возвращены в список')
  }

  const deleteTables = (tableIds: string[]) => {
    const ids = new Set(tableIds)
    const tables = project.tables.filter((item) => ids.has(item.id))
    if (!tables.length) return
    const names = tables.flatMap((table) => Object.values(table.assignments))
      .map((id) => project.guests.find((guest) => guest.id === id)?.name)
      .filter(Boolean)
    const message = names.length
      ? `Удалить выбранные столы (${tables.length})? Гости вернутся в список:\n${names.join(', ')}`
      : tables.length === 1 ? `Удалить «${tables[0].name}»?` : `Удалить выбранные столы (${tables.length})?`
    if (!window.confirm(message)) return
    const remaining = project.tables.filter((item) => !ids.has(item.id))
    history.commit({ ...project, tables: remaining })
    setSelectedTableIds([])
  }

  const updateTable = (id: string, patch: Partial<SeatingTable>, destructive = false) => {
    const table = project.tables.find((item) => item.id === id)
    if (!table) return
    if (destructive && Object.keys(table.assignments).length) {
      const names = Object.values(table.assignments).map((guestId) => project.guests.find((g) => g.id === guestId)?.name).filter(Boolean)
      if (!window.confirm(`Изменение освободит места гостей:\n${names.join(', ')}\nПродолжить?`)) return
      patch.assignments = {}
      patch.approvedSeats = {}
    }
    const tables = project.tables.map((item) => item.id === id ? { ...item, ...patch } : item)
    history.commit({ ...project, tables })
  }

  const updateSeatCount = (tableId: string, targetCount: number, side?: Side) => {
    const table = project.tables.find((item) => item.id === tableId)
    if (!table) return
    const guestsToReset = resizeSeatsWouldRemoveGuests(table, targetCount, side)
    if (guestsToReset.length) {
      const names = guestsToReset.map((guestId) => project.guests.find((guest) => guest.id === guestId)?.name).filter(Boolean)
      const label = side ? 'этой стороне' : 'этом столе'
      if (!window.confirm(`Не хватает пустых мест на ${label}. Эти гости вернутся в список:\n${names.join(', ')}\nПродолжить?`)) return
    }
    history.commit({
      ...project,
      tables: project.tables.map((item) => item.id === tableId ? resizeSeats(item, targetCount, side) : item),
    })
    setSeatMenu(undefined)
  }

  const deleteEmptySeat = (tableId: string, seatId: string) => {
    const table = project.tables.find((item) => item.id === tableId)
    if (!table || table.assignments[seatId]) return
    history.commit({
      ...project,
      tables: project.tables.map((item) => item.id === tableId ? removeEmptySeat(item, seatId) : item),
    })
    setSeatMenu(undefined)
  }

  const moveSelected = (tableIds: string[], dx: number, dy: number, record = false) => {
    const ids = new Set(tableIds)
    const updater = (current: ProjectState): ProjectState => ({
      ...current,
      tables: current.tables.map((table) => ids.has(table.id) ? { ...table, x: table.x + dx, y: table.y + dy } : table),
    })
    record ? history.commit(updater) : history.replace(updater)
  }

  const rotateSelection = (tableIds: string[], direction: -1 | 1) => {
    const ids = new Set(tableIds)
    const members = project.tables.filter((table) => ids.has(table.id))
    if (!members.length) return
    const center = members.reduce((acc, table) => {
      const size = tableSize(table)
      return { x: acc.x + (table.x + size.width / 2) / members.length, y: acc.y + (table.y + size.height / 2) / members.length }
    }, { x: 0, y: 0 })
    const angle = direction * 15 * Math.PI / 180
    const rotated = project.tables.map((table) => {
      if (!members.some((member) => member.id === table.id)) return table
      const size = tableSize(table)
      const tableCenterX = table.x + size.width / 2
      const tableCenterY = table.y + size.height / 2
      const dx = tableCenterX - center.x
      const dy = tableCenterY - center.y
      return {
        ...table,
        x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle) - size.width / 2,
        y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle) - size.height / 2,
        rotation: (table.rotation + direction * 15 + 360) % 360,
      }
    })
    history.commit({ ...project, tables: rotated })
  }

  const trySnap = (tableId: string) => {
    history.replace((current) => {
      const moving = current.tables.find((table) => table.id === tableId)
      if (!moving || moving.shape !== 'rectangle') return current
      // Магнит ощущается одинаково при любом масштабе: около 56 px на экране.
      const best = findSnapCandidate(moving, current.tables, 56 / zoom)
      if (!best) return current
      const shifted = current.tables.map((table) => table.id === moving.id
        ? { ...table, x: table.x + best.dx, y: table.y + best.dy }
        : table)
      window.setTimeout(() => showToast('Стол примагничен'), 0)
      return { ...current, tables: shifted }
    })
  }

  const onCanvasPointerDown = (event: React.PointerEvent) => {
    if (event.button === 1 || canvasTool === 'pan') {
      event.preventDefault()
      panDrag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
      event.currentTarget.setPointerCapture(event.pointerId)
    } else if (canvasTool === 'select' && event.target === event.currentTarget) {
      setSeatMenu(undefined)
      const rect = event.currentTarget.getBoundingClientRect()
      selectionDrag.current = {
        startX: event.clientX - rect.left,
        startY: event.clientY - rect.top,
        additive: event.shiftKey,
      }
      const box = { left: event.clientX - rect.left, top: event.clientY - rect.top, width: 0, height: 0 }
      selectionBoxRef.current = box
      setSelectionBox(box)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }
  const onCanvasPointerMove = (event: React.PointerEvent) => {
    if (panDrag.current) {
      setPan({
        x: panDrag.current.px + event.clientX - panDrag.current.x,
        y: panDrag.current.py + event.clientY - panDrag.current.y,
      })
      return
    }
    if (selectionDrag.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const box = {
        left: Math.min(selectionDrag.current.startX, x),
        top: Math.min(selectionDrag.current.startY, y),
        width: Math.abs(x - selectionDrag.current.startX),
        height: Math.abs(y - selectionDrag.current.startY),
      }
      selectionBoxRef.current = box
      setSelectionBox(box)
      return
    }
    const drag = tableDrag.current
    if (!drag) return
    const nx = Math.round((drag.x + (event.clientX - drag.px) / zoom) / GRID) * GRID
    const ny = Math.round((drag.y + (event.clientY - drag.py) / zoom) / GRID) * GRID
    history.replace((current) => {
      const table = current.tables.find((item) => item.id === drag.id)
      if (!table) return current
      const ids = new Set(drag.ids)
      const dx = nx - table.x
      const dy = ny - table.y
      return {
        ...current,
        tables: current.tables.map((item) => ids.has(item.id) ? { ...item, x: item.x + dx, y: item.y + dy } : item),
      }
    })
  }
  const onCanvasPointerUp = () => {
    const currentBox = selectionBoxRef.current
    if (selectionDrag.current && currentBox && canvasRef.current) {
      const additive = selectionDrag.current.additive
      const canvasRect = canvasRef.current.getBoundingClientRect()
      const selected = project.tables.filter((table) => {
        const element = canvasRef.current!.querySelector<HTMLElement>(`[data-table-id="${table.id}"]`)
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const left = rect.left - canvasRect.left
        const top = rect.top - canvasRect.top
        return left < currentBox.left + currentBox.width &&
          left + rect.width > currentBox.left &&
          top < currentBox.top + currentBox.height &&
          top + rect.height > currentBox.top
      }).map((table) => table.id)
      setSelectedTableIds((current) => additive
        ? [...new Set([...current, ...selected])]
        : selected)
      selectionDrag.current = undefined
      selectionBoxRef.current = undefined
      setSelectionBox(undefined)
    }
    if (tableDrag.current) {
      if (tableDrag.current.ids.length === 1) trySnap(tableDrag.current.id)
      tableDrag.current = undefined
      history.endTransient()
    }
    panDrag.current = undefined
  }
  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault()
    setZoom((value) => Math.min(1.7, Math.max(0.3, value - event.deltaY * 0.001)))
  }

  const fitAll = () => {
    if (!project.tables.length) return
    const bounds = project.tables.reduce((acc, table) => {
      const size = tableSize(table)
      return {
        minX: Math.min(acc.minX, table.x - 70),
        minY: Math.min(acc.minY, table.y - 70),
        maxX: Math.max(acc.maxX, table.x + size.width + 70),
        maxY: Math.max(acc.maxY, table.y + size.height + 70),
      }
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const nextZoom = Math.min(1, (rect.width - 80) / (bounds.maxX - bounds.minX), (rect.height - 80) / (bounds.maxY - bounds.minY))
    setZoom(nextZoom)
    setPan({ x: 40 - bounds.minX * nextZoom, y: 40 - bounds.minY * nextZoom })
  }

  const applyTemplate = (kind: 'rows' | 'u' | 'long', count: number, shape: TableShape) => {
    if (project.tables.length && !window.confirm('Шаблон удалит все текущие столы, а гости вернутся в список. Продолжить?')) return
    history.commit({ ...project, tables: createTemplate(kind, count, kind === 'rows' ? shape : 'rectangle') })
    setSelectedTableIds([])
    setTemplateDialog(false)
    window.setTimeout(fitAll, 50)
  }

  const saveJson = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    downloadBlob(blob, `${safeFilename(project.eventName || 'план-рассадки')}.json`)
  }
  const loadJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!validateProject(parsed)) throw new Error()
      if (!window.confirm('Загруженный проект заменит текущий. Продолжить?')) return
      history.resetHistory(normalizeProject(parsed))
      setSelectedTableIds([])
      showToast('Проект загружен')
    } catch {
      showToast('Файл повреждён или имеет неверный формат')
    }
  }
  const newProject = () => {
    if (!window.confirm('Создать новый проект? Текущие данные будут очищены.')) return
    if (window.confirm('Скачать резервную копию текущего проекта?')) saveJson()
    history.resetHistory(emptyProject())
    setSelectedTableIds([])
  }
  const exportPng = async () => {
    if (!project.tables.length) return showToast('Добавьте хотя бы один стол')
    if (seated.size < project.guests.length && !window.confirm(`Остались нерассаженные гости: ${project.guests.length - seated.size}. Всё равно экспортировать?`)) return
    try {
      const node = exportRef.current
      if (!node) return
      const dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true })
      const response = await fetch(dataUrl)
      downloadBlob(await response.blob(), `${safeFilename(project.eventName || 'план-рассадки')}.png`)
      showToast('PNG сохранён')
    } catch {
      showToast('Не удалось создать PNG')
    }
  }

  const toggleSeatApproved = (tableId: string, seatId: string) => {
    const table = project.tables.find((item) => item.id === tableId)
    if (!table?.assignments[seatId]) return
    history.commit({
      ...project,
      tables: project.tables.map((item) => {
        if (item.id !== tableId) return item
        const approvedSeats = { ...(item.approvedSeats || {}) }
        if (approvedSeats[seatId]) delete approvedSeats[seatId]
        else approvedSeats[seatId] = true
        return { ...item, approvedSeats }
      }),
    })
    setSeatMenu(undefined)
  }

  const seatMenuData = useMemo(() => {
    if (!seatMenu) return undefined
    const table = project.tables.find((item) => item.id === seatMenu.tableId)
    const guestId = table?.assignments[seatMenu.seatId]
    const guest = project.guests.find((item) => item.id === guestId)
    if (!table || !guest) return undefined
    return { ...seatMenu, table, guest, approved: !!table.approvedSeats?.[seatMenu.seatId] }
  }, [project.guests, project.tables, seatMenu])

  const filteredGuests = project.guests.filter((guest) => {
    const matches = guest.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))
    return matches && (filter === 'all' || (filter === 'seated' ? seated.has(guest.id) : !seated.has(guest.id)))
  })

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Armchair size={20} /></div>
          <div><strong>План рассадки</strong><span>редактор свадебного зала</span></div>
        </div>
        <input
          className="event-input"
          value={project.eventName}
          maxLength={60}
          placeholder="Название события"
          onChange={(event) => history.commit({ ...project, eventName: event.target.value })}
        />
        <div className="stats">
          <Stat label="Гостей" value={project.guests.length} />
          <Stat label="Рассажено" value={seated.size} />
          <Stat label="Не рассажено" value={project.guests.length - seated.size} warn />
          <Stat label="Свободно мест" value={freeSeats} />
        </div>
        <div className="top-actions">
          <IconButton title="Отменить (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}><Undo2 /></IconButton>
          <IconButton title="Повторить (Ctrl+Y)" disabled={!history.canRedo} onClick={history.redo}><Redo2 /></IconButton>
          <button className="button quiet" onClick={() => setTemplateDialog(true)}><Grid2X2 /> Шаблоны</button>
          <button className="button primary" onClick={exportPng}><Download /> Экспорт PNG</button>
          <div className="more-menu">
            <button className="button quiet">Проект <ChevronRight /></button>
            <div className="more-popover">
              <button onClick={newProject}><CirclePlus /> Новый проект</button>
              <button onClick={saveJson}><FileDown /> Скачать JSON</button>
              <label><FileUp /> Загрузить JSON<input type="file" accept=".json,application/json" onChange={loadJson} /></label>
            </div>
          </div>
        </div>
      </header>

      <main className="workspace">
        <aside className="guest-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Список</span><h2>Гости</h2></div>
            <span className="counter">{project.guests.length}/{MAX_GUESTS}</span>
          </div>
          <form className="guest-form" onSubmit={(event) => { event.preventDefault(); addGuest() }}>
            <input value={guestName} maxLength={50} placeholder="Имя гостя" onChange={(event) => setGuestName(event.target.value)} />
            <button aria-label="Добавить гостя" disabled={!guestName.trim()}><Plus /></button>
          </form>
          <form className="group-form" onSubmit={(event) => { event.preventDefault(); addGroup() }}>
            <input value={groupName} maxLength={40} placeholder="Новая группа гостей" onChange={(event) => setGroupName(event.target.value)} />
            <button aria-label="Добавить группу" disabled={!groupName.trim()}><Plus /></button>
          </form>
          {!!project.guestGroups.length && (
            <>
              <div className="group-list" aria-label="Группы гостей">
                {project.guestGroups.map((group) => (
                  <div key={group.id} className={`group-chip ${selectedGroupId === group.id ? 'active' : ''}`} style={{ '--group-color': group.color } as React.CSSProperties}>
                    <button type="button" title="Выбрать группу" onClick={() => setSelectedGroupId(group.id)}>{group.name}</button>
                    <button type="button" title="Переименовать группу" onClick={() => renameGroup(group.id)}>✎</button>
                    <button type="button" title="Удалить группу" onClick={() => removeGroup(group.id)}><X /></button>
                  </div>
                ))}
              </div>
              {selectedGroup && (
                <div className="group-palette" aria-label={`Цвет группы ${selectedGroup.name}`}>
                  <span>Цвет: {selectedGroup.name}</span>
                  <div>
                    {GROUP_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={selectedGroup.color === color ? 'active' : ''}
                        title={color}
                        aria-label={`Выбрать цвет ${color}`}
                        style={{ '--swatch-color': color } as React.CSSProperties}
                        onClick={() => setGroupColor(selectedGroup.id, color)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="search"><Search /><input value={query} placeholder="Найти гостя" onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="filters">
            {([['all', 'Все'], ['unseated', 'Не рассажены'], ['seated', 'Рассажены']] as [Filter, string][]).map(([value, label]) =>
              <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>,
            )}
          </div>
          <div className="reset-guests-actions">
            <button className="button quiet full reset-guests-button" onClick={resetUnapprovedSeatedGuests}><Check /> Сбросить неутверждённых</button>
            <button className="button quiet full reset-guests-button" onClick={resetAllGuests}><Users /> Сбросить всех гостей</button>
          </div>
          <div className="guest-list">
            {!filteredGuests.length && <div className="empty-list"><Users /><span>{project.guests.length ? 'Ничего не найдено' : 'Добавьте первого гостя'}</span></div>}
            {filteredGuests.map((guest) => {
              const group = guest.groupId ? groupById.get(guest.groupId) : undefined
              return (
                <div
                  key={guest.id}
                  className={`guest-card ${seated.has(guest.id) ? 'seated' : ''}`}
                  style={{ '--guest-color': group?.color || '#cbd3cf' } as React.CSSProperties}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('text/guest-id', guest.id)}
                >
                  <span className="guest-color" title={group?.name || 'Без группы'} />
                  <span className="guest-grip">⠿</span>
                  <span className="guest-name" title={guest.name}>{guest.name}</span>
                  <span className="guest-state">{seated.has(guest.id) ? 'за столом' : 'не рассажен'}</span>
                  <button title="Редактировать" onClick={() => editGuest(guest.id)}>✎</button>
                  <button title="Удалить" onClick={() => removeGuest(guest.id)}><X /></button>
                  <select
                    value={guest.groupId || ''}
                    title="Группа гостя"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setGuestGroup(guest.id, event.target.value)}
                  >
                    <option value="">Без группы</option>
                    {project.guestGroups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
              )
            })}
          </div>
        </aside>

        <section className={`canvas-shell ${canvasTool === 'pan' ? 'panning' : ''}`}>
          <div
            ref={canvasRef}
            className="canvas"
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
            onWheel={onWheel}
          >
            {!project.tables.length && (
              <div className="canvas-empty">
                <div className="empty-table-icon"><span /><span /><span /><span /></div>
                <h2>Зал пока пуст</h2>
                <p>Добавьте стол или начните со стандартной расстановки.</p>
                <div><button className="button primary" onClick={() => setTableDialog(true)}><Plus /> Добавить стол</button><button className="button quiet" onClick={() => setTemplateDialog(true)}>Выбрать шаблон</button></div>
              </div>
            )}
            <div className="world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
              {project.tables.map((table) => (
                <TableView
                  key={table.id}
                  table={table}
                  guests={project.guests}
                  guestGroups={project.guestGroups}
                  selected={selectedTableIds.includes(table.id)}
                  seatMenu={seatMenu}
                  onSelect={(additive) => {
                    if (canvasTool === 'pan') return
                    setSelectedTableIds((current) => additive
                      ? current.includes(table.id) ? current.filter((id) => id !== table.id) : [...current, table.id]
                      : [table.id])
                    setSeatMenu(undefined)
                  }}
                  onDragStart={(event) => {
                    if (event.button !== 0 || canvasTool === 'pan') return
                    event.stopPropagation()
                    const nextSelection = event.shiftKey
                      ? selectedTableIds.includes(table.id)
                        ? selectedTableIds
                        : [...selectedTableIds, table.id]
                      : selectedTableIds.includes(table.id)
                        ? selectedTableIds
                        : [table.id]
                    setSelectedTableIds(nextSelection)
                    history.beginTransient()
                    tableDrag.current = {
                      id: table.id,
                      x: table.x,
                      y: table.y,
                      px: event.clientX,
                      py: event.clientY,
                      ids: [...new Set(nextSelection)],
                    }
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onDrop={(guestId, seatId) => history.commit(assignGuest(project, guestId, table.id, seatId))}
                  onDeleteEmptySeat={(seatId) => deleteEmptySeat(table.id, seatId)}
                  onSeatMenu={(seatId, event) => setSeatMenu({
                    tableId: table.id,
                    seatId,
                    x: Math.max(8, Math.min(event.clientX + 8, window.innerWidth - 194)),
                    y: Math.max(8, Math.min(event.clientY + 8, window.innerHeight - 178)),
                  })}
                />
              ))}
            </div>
            {selectionBox && <div className="selection-box" style={selectionBox} />}
          </div>
          {!groupsTooltipHidden ? (
            <div className="group-summary-tooltip" aria-label="Сводка по группам гостей">
              <div className="group-summary-head">
                <div><span className="eyebrow">Группы</span><strong>{project.guests.length} гостей</strong></div>
                <button title="Скрыть группы" aria-label="Скрыть группы" onClick={() => setGroupsTooltipHidden(true)}><X /></button>
              </div>
              <div className="group-summary-list">
                {groupStats.groups.length ? groupStats.groups.map((group) => (
                  <div key={group.id} className="group-summary-row" style={{ '--group-color': group.color } as React.CSSProperties}>
                    <span /><b title={group.name}>{group.name}</b><em>{group.count}</em>
                  </div>
                )) : <p>Группы пока не добавлены</p>}
                {!!groupStats.ungrouped && (
                  <div className="group-summary-row muted" style={{ '--group-color': '#b9c2bd' } as React.CSSProperties}>
                    <span /><b>Без группы</b><em>{groupStats.ungrouped}</em>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <button className="group-summary-toggle" onClick={() => setGroupsTooltipHidden(false)}><Users /> Группы</button>
          )}
          <div className="canvas-toolbar">
            <button className={`tool-button ${canvasTool === 'select' ? 'active' : ''}`} title="Курсор (C)" onClick={() => setCanvasTool('select')}><MousePointer2 /><kbd>C</kbd></button>
            <button className={`tool-button ${canvasTool === 'pan' ? 'active' : ''}`} title="Перемещение схемы (V)" onClick={() => setCanvasTool('pan')}><Hand /><kbd>V</kbd></button>
            <i />
            <IconButton title="Уменьшить" onClick={() => setZoom((value) => Math.max(0.3, value - 0.1))}><Minus /></IconButton>
            <span>{Math.round(zoom * 100)}%</span>
            <IconButton title="Увеличить" onClick={() => setZoom((value) => Math.min(1.7, value + 0.1))}><Plus /></IconButton>
            <i />
            <IconButton title="Показать все столы" onClick={fitAll}><Maximize2 /></IconButton>
          </div>
          <button className="add-table-floating button primary" onClick={() => setTableDialog(true)}><Plus /> Добавить стол</button>
        </section>

        <aside className="settings-panel panel">
          {selectedTableIds.length > 1 ? (
            <MultiTableSettings
              count={selectedTableIds.length}
              onRotate={(direction) => rotateSelection(selectedTableIds, direction)}
              onDelete={() => deleteTables(selectedTableIds)}
              onClear={() => setSelectedTableIds([])}
            />
          ) : selectedTable ? (
            <TableSettings
              table={selectedTable}
              onUpdate={updateTable}
              onResizeSeats={updateSeatCount}
              onRotate={(direction) => rotateSelection([selectedTable.id], direction)}
              onDelete={() => deleteTables([selectedTable.id])}
            />
          ) : (
            <div className="settings-empty">
              <div className="selection-icon"><ChevronLeft /><span /></div>
              <h2>Выберите стол</h2>
              <p>Нажмите на стол или обведите несколько столов рамкой на холсте.</p>
              <div className="key-hints"><span><kbd>C</kbd> курсор</span><span><kbd>V</kbd> двигать схему</span><span><kbd>Shift</kbd> добавить к выбору</span><span><kbd>Колесо</kbd> масштаб</span><span><kbd>Del</kbd> удалить столы</span></div>
            </div>
          )}
        </aside>
      </main>

      <div className="export-stage" aria-hidden="true">
        <div ref={exportRef} className="export-sheet" style={{ width: exportBounds.width, height: exportBounds.height + 100 }}>
          <h1>{project.eventName || 'План рассадки'}</h1>
          <div className="export-map" style={{ width: exportBounds.width, height: exportBounds.height }}>
            {project.tables.map((table) => <ExportTable key={table.id} table={table} guests={project.guests} offsetX={exportBounds.minX} offsetY={exportBounds.minY} />)}
          </div>
        </div>
      </div>

      {tableDialog && <TableDialog index={project.tables.length + 1} onClose={() => setTableDialog(false)} onCreate={(shape, name, sides, circleSeats) => {
        if (project.tables.length >= MAX_TABLES) return showToast('Достигнут лимит: 50 столов')
        const table = createTable(project.tables.length + 1, shape, 360 - pan.x / zoom, 260 - pan.y / zoom)
        table.name = name
        table.sideSeats = sides
        table.circleSeats = circleSeats
        history.commit({ ...project, tables: [...project.tables, table] })
        setSelectedTableIds([table.id])
        setTableDialog(false)
      }} />}
      {templateDialog && <TemplateDialog onClose={() => setTemplateDialog(false)} onApply={applyTemplate} />}
      {seatMenuData && createPortal(
        <SeatActionMenu
          data={seatMenuData}
          onToggleApproved={() => toggleSeatApproved(seatMenuData.tableId, seatMenuData.seatId)}
          onReturnGuest={() => returnGuest(seatMenuData.guest.id)}
          onEditGuest={() => editGuest(seatMenuData.guest.id)}
          onDeleteGuest={() => removeGuest(seatMenuData.guest.id)}
        />,
        document.body,
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function TableView({ table, guests, guestGroups, selected, seatMenu, onSelect, onDragStart, onDrop, onDeleteEmptySeat, onSeatMenu }: {
  table: SeatingTable
  guests: ProjectState['guests']
  guestGroups: ProjectState['guestGroups']
  selected: boolean
  seatMenu?: SeatMenuState
  onSelect: (additive: boolean) => void
  onDragStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onDrop: (guestId: string, seatId: string) => void
  onDeleteEmptySeat: (seatId: string) => void
  onSeatMenu: (seatId: string, event: React.MouseEvent<HTMLDivElement>) => void
}) {
  const size = tableSize(table)
  const seats = getSeats(table)
  const groupById = new Map(guestGroups.map((group) => [group.id, group]))
  return (
    <div
      data-table-id={table.id}
      className={`table-wrap ${selected ? 'selected' : ''}`}
      style={{ left: table.x, top: table.y, width: size.width, height: size.height, transform: `rotate(${table.rotation}deg)` }}
      onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey) }}
    >
      <div className={`table-body ${table.shape}`} onPointerDown={onDragStart}>
        <span className="table-name">{table.name}</span>
        <span className="table-meta">{seats.length} мест</span>
      </div>
      {seats.map((seat) => {
        const guestId = table.assignments[seat.id]
        const guest = guests.find((item) => item.id === guestId)
        const menuOpen = seatMenu?.tableId === table.id && seatMenu.seatId === seat.id
        const group = guest?.groupId ? groupById.get(guest.groupId) : undefined
        const approved = !!table.approvedSeats?.[seat.id]
        return (
          <div
            key={seat.id}
            className={`seat ${guest ? 'occupied' : ''} ${approved ? 'approved' : ''}`}
            data-menu-open={menuOpen ? 'true' : undefined}
            data-guest-group={group?.name}
            style={{ left: seat.x, top: seat.y, transform: `translate(-50%, -50%) rotate(${-table.rotation}deg)`, '--seat-group-color': group?.color || '#8ab7a3' } as React.CSSProperties}
            title={guest?.name || `Место ${seat.number}`}
            draggable={!!guest}
            onDragStart={(event) => {
              event.stopPropagation()
              if (guest) event.dataTransfer.setData('text/guest-id', guest.id)
            }}
            onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const id = event.dataTransfer.getData('text/guest-id')
              if (id) onDrop(id, seat.id)
            }}
            onClick={(event) => {
              event.stopPropagation()
              if (guest) onSeatMenu(seat.id, event)
            }}
          >
            <b>{seat.number}</b>
            <span>{guest ? guest.name : 'свободно'}</span>
            {!guest && (
              <button
                type="button"
                className="seat-delete-button"
                title="Удалить пустое место"
                aria-label={`Удалить пустое место ${seat.number}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onDeleteEmptySeat(seat.id)
                }}
              >
                <X />
              </button>
            )}
            {approved && <em className="seat-approved" title="Место утверждено">✓</em>}
          </div>
        )
      })}
    </div>
  )
}

function SeatActionMenu({ data, onToggleApproved, onReturnGuest, onEditGuest, onDeleteGuest }: {
  data: SeatMenuState & { guest: ProjectState['guests'][number]; table: SeatingTable; approved: boolean }
  onToggleApproved: () => void
  onReturnGuest: () => void
  onEditGuest: () => void
  onDeleteGuest: () => void
}) {
  return (
    <div
      className="seat-menu-portal"
      style={{ left: data.x, top: data.y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <strong title={data.guest.name}>{data.guest.name}</strong>
      <button onClick={onToggleApproved}><Check /> {data.approved ? 'Снять утверждение' : 'Утвердить гостя'}</button>
      <button onClick={onReturnGuest}>Вернуть в список</button>
      <button onClick={onEditGuest}>Изменить имя</button>
      <button className="danger" onClick={onDeleteGuest}>Удалить гостя</button>
    </div>
  )
}

function MultiTableSettings({ count, onRotate, onDelete, onClear }: {
  count: number
  onRotate: (direction: -1 | 1) => void
  onDelete: () => void
  onClear: () => void
}) {
  return <>
    <div className="panel-heading settings-title">
      <div><span className="eyebrow">Групповое действие</span><h2>Выбрано столов: {count}</h2></div>
    </div>
    <div className="settings-scroll">
      <p className="multi-selection-note">Перетаскивайте любой выбранный стол, чтобы переместить всё выделение.</p>
      <div className="field"><span>Поворот выделения</span><div className="rotation-control">
        <button onClick={() => onRotate(-1)}><RotateCcw /> −15°</button>
        <strong>{count}</strong>
        <button onClick={() => onRotate(1)}>+15° <RotateCw /></button>
      </div></div>
      <button className="button full quiet" onClick={onClear}><X /> Снять выделение</button>
    </div>
    <div className="settings-footer"><button className="button danger-button" onClick={onDelete}><Trash2 /> Удалить выбранные столы</button></div>
  </>
}

function TableSettings({ table, onUpdate, onResizeSeats, onRotate, onDelete }: {
  table: SeatingTable
  onUpdate: (id: string, patch: Partial<SeatingTable>, destructive?: boolean) => void
  onResizeSeats: (id: string, targetCount: number, side?: Side) => void
  onRotate: (direction: -1 | 1) => void
  onDelete: () => void
}) {
  const setSeats = (side: Side, value: number) => {
    const next = Math.max(0, Math.min(MAX_SEATS, value))
    onResizeSeats(table.id, next, side)
  }
  return (
    <>
      <div className="panel-heading settings-title"><div><span className="eyebrow">Настройки</span><h2>{table.name}</h2></div></div>
      <div className="settings-scroll">
        <label className="field"><span>Название стола</span><input value={table.name} maxLength={30} onChange={(event) => onUpdate(table.id, { name: event.target.value })} /></label>
        <div className="field"><span>Форма</span><div className="shape-picker">
          {([['rectangle', 'Прямой'], ['oval', 'Овальный'], ['circle', 'Круглый']] as [TableShape, string][]).map(([shape, label]) =>
            <button key={shape} className={table.shape === shape ? 'active' : ''} onClick={() => {
              if (shape !== table.shape && window.confirm('При смене формы рассаженные гости вернутся в список. Продолжить?')) {
                const diameter = Math.round((table.width + table.height) / 2)
                onUpdate(table.id, shape === 'circle'
                  ? { shape, width: diameter, height: diameter, assignments: {}, approvedSeats: {} }
                  : { shape, assignments: {}, approvedSeats: {} })
              }
            }}><i className={shape} />{label}</button>,
          )}
        </div></div>
        <div className="field">
          <span>Размер стола</span>
          {table.shape === 'circle' ? (
            <label className="dimension-row"><span>Диаметр</span><NumberStepper value={table.width} min={MIN_TABLE_WIDTH} max={MAX_TABLE_HEIGHT} step={10} onChange={(value) => onUpdate(table.id, { width: value, height: value })} /></label>
          ) : (
            <div className="dimension-grid">
              <label><span>Длина</span><NumberStepper value={table.width} min={MIN_TABLE_WIDTH} max={MAX_TABLE_WIDTH} step={10} onChange={(value) => onUpdate(table.id, { width: value })} /></label>
              <label><span>Ширина</span><NumberStepper value={table.height} min={MIN_TABLE_HEIGHT} max={MAX_TABLE_HEIGHT} step={10} onChange={(value) => onUpdate(table.id, { height: value })} /></label>
            </div>
          )}
          <small className="field-hint">Размер меняет только внешний вид стола. Количество мест останется прежним.</small>
        </div>
        {table.shape === 'circle' ? (
          <label className="field"><span>Количество мест</span><NumberStepper value={table.circleSeats} onChange={(value) => onResizeSeats(table.id, value)} /></label>
        ) : (
          <div className="field">
            <span>Места по сторонам</span>
            <div className="side-grid">
              {([['top', 'Сверху'], ['right', 'Справа'], ['bottom', 'Снизу'], ['left', 'Слева']] as [Side, string][]).map(([side, label]) =>
                <label key={side}><span>{label}</span><NumberStepper value={table.sideSeats[side]} onChange={(value) => setSeats(side, value)} /></label>,
              )}
            </div>
          </div>
        )}
        <div className="field"><span>Поворот</span><div className="rotation-control">
          <button onClick={() => onRotate(-1)}><RotateCcw /> −15°</button>
          <strong>{table.rotation}°</strong>
          <button onClick={() => onRotate(1)}>+15° <RotateCw /></button>
        </div></div>
      </div>
      <div className="settings-footer"><button className="button danger-button" onClick={onDelete}><Trash2 /> Удалить стол</button></div>
    </>
  )
}

function TableDialog({ index, onClose, onCreate }: {
  index: number
  onClose: () => void
  onCreate: (shape: TableShape, name: string, sides: Record<Side, number>, circleSeats: number) => void
}) {
  const [shape, setShape] = useState<TableShape>('rectangle')
  const [name, setName] = useState(`Стол ${index}`)
  const [sides, setSides] = useState<Record<Side, number>>({ top: 3, right: 1, bottom: 3, left: 1 })
  const [circleSeats, setCircleSeats] = useState(8)
  return <Modal title="Новый стол" onClose={onClose}>
    <label className="field"><span>Название</span><input autoFocus value={name} maxLength={30} onChange={(event) => setName(event.target.value)} /></label>
    <div className="field"><span>Форма</span><div className="shape-picker">
      {([['rectangle', 'Прямой'], ['oval', 'Овальный'], ['circle', 'Круглый']] as [TableShape, string][]).map(([value, label]) =>
        <button key={value} className={shape === value ? 'active' : ''} onClick={() => setShape(value)}><i className={value} />{label}</button>,
      )}
    </div></div>
    {shape === 'circle'
      ? <label className="field"><span>Количество мест</span><NumberStepper value={circleSeats} onChange={setCircleSeats} /></label>
      : <div className="field"><span>Места по сторонам</span><div className="side-grid">
        {([['top', 'Сверху'], ['right', 'Справа'], ['bottom', 'Снизу'], ['left', 'Слева']] as [Side, string][]).map(([side, label]) =>
          <label key={side}><span>{label}</span><NumberStepper value={sides[side]} onChange={(value) => setSides({ ...sides, [side]: value })} /></label>,
        )}
      </div></div>}
    <div className="dialog-actions"><button className="button quiet" onClick={onClose}>Отмена</button><button className="button primary" disabled={!name.trim()} onClick={() => onCreate(shape, name.trim(), sides, circleSeats)}>Добавить стол</button></div>
  </Modal>
}

function TemplateDialog({ onClose, onApply }: {
  onClose: () => void
  onApply: (kind: 'rows' | 'u' | 'long', count: number, shape: TableShape) => void
}) {
  const [kind, setKind] = useState<'rows' | 'u' | 'long'>('rows')
  const [count, setCount] = useState(6)
  const [shape, setShape] = useState<TableShape>('rectangle')
  return <Modal title="Стандартная расстановка" onClose={onClose}>
    <div className="template-grid">
      {([['rows', 'Рядами', '▦'], ['u', 'Буквой «П»', '⊔'], ['long', 'Длинный стол', '▬']] as const).map(([value, label, icon]) =>
        <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}><b>{icon}</b><span>{label}</span></button>,
      )}
    </div>
    <label className="field"><span>Количество столов</span><NumberStepper value={count} max={MAX_TABLES} onChange={setCount} /></label>
    {kind === 'rows' && <div className="field"><span>Форма столов</span><div className="shape-picker">
      {([['rectangle', 'Прямые'], ['oval', 'Овальные'], ['circle', 'Круглые']] as [TableShape, string][]).map(([value, label]) =>
        <button key={value} className={shape === value ? 'active' : ''} onClick={() => setShape(value)}><i className={value} />{label}</button>,
      )}
    </div></div>}
    <p className="warning-note">Применение шаблона удалит текущие столы и вернёт всех гостей в список.</p>
    <div className="dialog-actions"><button className="button quiet" onClick={onClose}>Отмена</button><button className="button primary" onClick={() => onApply(kind, count, shape)}>Применить шаблон</button></div>
  </Modal>
}

function ExportTable({ table, guests, offsetX, offsetY }: { table: SeatingTable; guests: ProjectState['guests']; offsetX: number; offsetY: number }) {
  const size = tableSize(table)
  return <div className="export-table-wrap" style={{ left: table.x - offsetX, top: table.y - offsetY, width: size.width, height: size.height, transform: `rotate(${table.rotation}deg)` }}>
    <div className={`export-table ${table.shape}`}><strong>{table.name}</strong></div>
    {getSeats(table).map((seat) => {
      const guest = guests.find((item) => item.id === table.assignments[seat.id])
      const approved = !!table.approvedSeats?.[seat.id]
      return <div key={seat.id} className={`export-seat ${guest ? 'filled' : ''} ${approved ? 'approved' : ''}`} style={{ left: seat.x, top: seat.y, transform: `translate(-50%, -50%) rotate(${-table.rotation}deg)` }}><b>{seat.number}</b><span>{guest?.name || '—'}</span>{approved && <em>✓</em>}</div>
    })}
  </div>
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal"><div className="modal-title"><h2>{title}</h2><button onClick={onClose}><X /></button></div>{children}</div>
  </div>
}

function NumberStepper({ value, onChange, min = 0, max = MAX_SEATS, step = 1 }: { value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState(String(value))
  const clamp = (next: number) => Math.max(min, Math.min(max, next))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    if (draft.trim() === '') {
      setDraft(String(value))
      return
    }
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = clamp(Math.round(parsed))
    setDraft(String(next))
    if (next !== value) onChange(next)
  }
  const stepValue = (direction: -1 | 1) => {
    const next = clamp(value + direction * step)
    setDraft(String(next))
    onChange(next)
  }
  return <div className="stepper">
    <button type="button" onClick={() => stepValue(-1)}><Minus /></button>
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      onChange={(event) => {
        const next = event.target.value
        if (/^\d*$/.test(next)) setDraft(next)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setDraft(String(value))
          event.currentTarget.blur()
        }
      }}
    />
    <button type="button" onClick={() => stepValue(1)}><Plus /></button>
  </div>
}

function IconButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className="icon-button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>{children}</button>
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return <div className={`stat ${warn && value > 0 ? 'warn' : ''}`}><strong>{value}</strong><span>{label}</span></div>
}

function safeFilename(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 80) || 'план-рассадки'
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
