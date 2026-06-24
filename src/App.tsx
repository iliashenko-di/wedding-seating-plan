import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Armchair, ChevronLeft, ChevronRight, CirclePlus, Download, FileDown,
  FileUp, Grid2X2, Link2Off, Maximize2, Minus, Plus, Redo2, RotateCcw,
  RotateCw, Search, Trash2, Undo2, Users, X,
} from 'lucide-react'
import { toPng } from 'html-to-image'
import {
  assignGuest, createTable, createTemplate, emptyProject, findSnapCandidate, getSeats, GRID,
  MAX_GUESTS, MAX_SEATS, MAX_TABLES, seatedGuestIds, tableSize, uid,
  rebuildGroupHiddenSides, validateProject, visibleSeatCount,
} from './model'
import type { ProjectState, SeatingTable, Side, TableShape } from './types'

const STORAGE_KEY = 'wedding-seating-project-v1'
type Filter = 'all' | 'unseated' | 'seated'

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
    return validateProject(parsed) ? parsed : emptyProject()
  } catch {
    return emptyProject()
  }
}

export default function App() {
  const history = useProjectHistory(loadInitialProject())
  const { project } = history
  const [selectedTableId, setSelectedTableId] = useState<string>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [guestName, setGuestName] = useState('')
  const [zoom, setZoom] = useState(0.8)
  const [pan, setPan] = useState({ x: 40, y: 40 })
  const [tableDialog, setTableDialog] = useState(false)
  const [templateDialog, setTemplateDialog] = useState(false)
  const [toast, setToast] = useState('')
  const [seatMenu, setSeatMenu] = useState<{ tableId: string; seatId: string }>()
  const [spaceDown, setSpaceDown] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | undefined>(undefined)
  const tableDrag = useRef<{ id: string; x: number; y: number; px: number; py: number } | undefined>(undefined)

  const seated = useMemo(() => seatedGuestIds(project), [project])
  const selectedTable = project.tables.find((table) => table.id === selectedTableId)
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
    const onKeyDown = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (event.code === 'Space' && !editable) {
        event.preventDefault()
        setSpaceDown(true)
      }
      if (editable) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? history.redo() : history.undo()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        history.redo()
      }
      if (event.key === 'Escape') {
        setSelectedTableId(undefined)
        setSeatMenu(undefined)
      }
      if (event.key === 'Delete' && selectedTableId) deleteTable(selectedTableId)
      if (selectedTableId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const delta = event.shiftKey ? GRID * 5 : GRID
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
        moveGroup(selectedTableId, dx, dy, true)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
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
      tables: project.tables.map((table) => ({
        ...table,
        assignments: Object.fromEntries(Object.entries(table.assignments).filter(([, id]) => id !== guestId)),
      })),
    })
    setSeatMenu(undefined)
  }

  const returnGuest = (guestId: string) => {
    history.commit({
      ...project,
      tables: project.tables.map((table) => ({
        ...table,
        assignments: Object.fromEntries(Object.entries(table.assignments).filter(([, id]) => id !== guestId)),
      })),
    })
    setSeatMenu(undefined)
  }

  const deleteTable = (tableId: string) => {
    const table = project.tables.find((item) => item.id === tableId)
    if (!table) return
    const names = Object.values(table.assignments)
      .map((id) => project.guests.find((guest) => guest.id === id)?.name)
      .filter(Boolean)
    const message = names.length
      ? `Удалить «${table.name}»? Гости вернутся в список:\n${names.join(', ')}`
      : `Удалить «${table.name}»?`
    if (!window.confirm(message)) return
    history.commit({ ...project, tables: project.tables.filter((item) => item.id !== tableId) })
    setSelectedTableId(undefined)
  }

  const updateTable = (id: string, patch: Partial<SeatingTable>, destructive = false) => {
    const table = project.tables.find((item) => item.id === id)
    if (!table) return
    if (destructive && Object.keys(table.assignments).length) {
      const names = Object.values(table.assignments).map((guestId) => project.guests.find((g) => g.id === guestId)?.name).filter(Boolean)
      if (!window.confirm(`Изменение освободит места гостей:\n${names.join(', ')}\nПродолжить?`)) return
      patch.assignments = {}
    }
    history.commit({ ...project, tables: project.tables.map((item) => item.id === id ? { ...item, ...patch } : item) })
  }

  const moveGroup = (tableId: string, dx: number, dy: number, record = false) => {
    const source = project.tables.find((table) => table.id === tableId)
    if (!source) return
    const member = (table: SeatingTable) => table.id === tableId || (!!source.groupId && table.groupId === source.groupId)
    const updater = (current: ProjectState): ProjectState => ({
      ...current,
      tables: current.tables.map((table) => member(table) ? { ...table, x: table.x + dx, y: table.y + dy } : table),
    })
    record ? history.commit(updater) : history.replace(updater)
  }

  const rotateGroup = (tableId: string, direction: -1 | 1) => {
    const source = project.tables.find((table) => table.id === tableId)
    if (!source) return
    const members = project.tables.filter((table) => table.id === tableId || (!!source.groupId && table.groupId === source.groupId))
    const center = members.reduce((acc, table) => {
      const size = tableSize(table)
      return { x: acc.x + (table.x + size.width / 2) / members.length, y: acc.y + (table.y + size.height / 2) / members.length }
    }, { x: 0, y: 0 })
    const angle = direction * 15 * Math.PI / 180
    history.commit({
      ...project,
      tables: project.tables.map((table) => {
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
      }),
    })
  }

  const detachTable = (tableId: string) => {
    const table = project.tables.find((item) => item.id === tableId)
    if (!table?.groupId) return
    const groupId = table.groupId
    const detached = project.tables.map((item) => item.id === tableId ? { ...item, groupId: undefined, hiddenSides: [] } : item)
    history.commit({ ...project, tables: rebuildGroupHiddenSides(detached, groupId) })
  }

  const trySnap = (tableId: string) => {
    const moving = project.tables.find((table) => table.id === tableId)
    if (!moving || moving.shape !== 'rectangle') return
    const best = findSnapCandidate(moving, project.tables)
    if (!best) return
    const occupied = getSeats(moving).some((seat) => seat.side === best!.side && moving.assignments[seat.id]) ||
      getSeats(best.other).some((seat) => seat.side === best!.otherSide && best!.other.assignments[seat.id])
    if (occupied) return showToast('Сначала пересадите гостей со сцепляемых сторон')
    const groupId = moving.groupId || best.other.groupId || uid('group')
    const mergedGroups = new Set([moving.groupId, best.other.groupId].filter(Boolean))
    history.replace((current) => ({
      ...current,
      tables: current.tables.map((table) => {
        const inMovingGroup = table.id === moving.id || (!!moving.groupId && table.groupId === moving.groupId)
        const inOtherGroup = table.id === best!.other.id || (!!best!.other.groupId && table.groupId === best!.other.groupId)
        if (inMovingGroup) return {
          ...table, x: table.x + best!.dx, y: table.y + best!.dy, groupId,
          hiddenSides: table.id === moving.id ? [...new Set([...table.hiddenSides, best!.side])] : table.hiddenSides,
        }
        if (inOtherGroup || (table.groupId && mergedGroups.has(table.groupId))) return {
          ...table, groupId,
          hiddenSides: table.id === best!.other.id ? [...new Set([...table.hiddenSides, best!.otherSide])] : table.hiddenSides,
        }
        return table
      }),
    }))
    showToast('Столы сцеплены')
  }

  const onCanvasPointerDown = (event: React.PointerEvent) => {
    if (event.button === 1 || spaceDown) {
      event.preventDefault()
      panDrag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
      event.currentTarget.setPointerCapture(event.pointerId)
    } else if (event.target === event.currentTarget) {
      setSelectedTableId(undefined)
      setSeatMenu(undefined)
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
    const drag = tableDrag.current
    if (!drag) return
    const nx = Math.round((drag.x + (event.clientX - drag.px) / zoom) / GRID) * GRID
    const ny = Math.round((drag.y + (event.clientY - drag.py) / zoom) / GRID) * GRID
    const table = project.tables.find((item) => item.id === drag.id)
    if (table) moveGroup(drag.id, nx - table.x, ny - table.y)
  }
  const onCanvasPointerUp = () => {
    if (tableDrag.current) {
      trySnap(tableDrag.current.id)
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
    setSelectedTableId(undefined)
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
      history.resetHistory(parsed)
      setSelectedTableId(undefined)
      showToast('Проект загружен')
    } catch {
      showToast('Файл повреждён или имеет неверный формат')
    }
  }
  const newProject = () => {
    if (!window.confirm('Создать новый проект? Текущие данные будут очищены.')) return
    if (window.confirm('Скачать резервную копию текущего проекта?')) saveJson()
    history.resetHistory(emptyProject())
    setSelectedTableId(undefined)
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
          <div className="search"><Search /><input value={query} placeholder="Найти гостя" onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="filters">
            {([['all', 'Все'], ['unseated', 'Не рассажены'], ['seated', 'Рассажены']] as [Filter, string][]).map(([value, label]) =>
              <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>,
            )}
          </div>
          <div className="guest-list">
            {!filteredGuests.length && <div className="empty-list"><Users /><span>{project.guests.length ? 'Ничего не найдено' : 'Добавьте первого гостя'}</span></div>}
            {filteredGuests.map((guest) => (
              <div
                key={guest.id}
                className={`guest-card ${seated.has(guest.id) ? 'seated' : ''}`}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('text/guest-id', guest.id)}
              >
                <span className="guest-grip">⠿</span>
                <span className="guest-name" title={guest.name}>{guest.name}</span>
                <span className="guest-state">{seated.has(guest.id) ? 'за столом' : 'не рассажен'}</span>
                <button title="Редактировать" onClick={() => editGuest(guest.id)}>✎</button>
                <button title="Удалить" onClick={() => removeGuest(guest.id)}><X /></button>
              </div>
            ))}
          </div>
        </aside>

        <section className={`canvas-shell ${spaceDown ? 'panning' : ''}`}>
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
                  selected={table.id === selectedTableId}
                  seatMenu={seatMenu}
                  onSelect={() => { setSelectedTableId(table.id); setSeatMenu(undefined) }}
                  onDragStart={(event) => {
                    if (event.button !== 0 || spaceDown) return
                    event.stopPropagation()
                    history.beginTransient()
                    tableDrag.current = { id: table.id, x: table.x, y: table.y, px: event.clientX, py: event.clientY }
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setSelectedTableId(table.id)
                  }}
                  onDrop={(guestId, seatId) => history.commit(assignGuest(project, guestId, table.id, seatId))}
                  onSeatMenu={(seatId) => setSeatMenu({ tableId: table.id, seatId })}
                  onReturnGuest={returnGuest}
                  onEditGuest={editGuest}
                  onDeleteGuest={removeGuest}
                />
              ))}
            </div>
          </div>
          <div className="canvas-toolbar">
            <IconButton title="Уменьшить" onClick={() => setZoom((value) => Math.max(0.3, value - 0.1))}><Minus /></IconButton>
            <span>{Math.round(zoom * 100)}%</span>
            <IconButton title="Увеличить" onClick={() => setZoom((value) => Math.min(1.7, value + 0.1))}><Plus /></IconButton>
            <i />
            <IconButton title="Показать все столы" onClick={fitAll}><Maximize2 /></IconButton>
          </div>
          <button className="add-table-floating button primary" onClick={() => setTableDialog(true)}><Plus /> Добавить стол</button>
        </section>

        <aside className="settings-panel panel">
          {selectedTable ? (
            <TableSettings
              table={selectedTable}
              onUpdate={updateTable}
              onRotate={(direction) => rotateGroup(selectedTable.id, direction)}
              onDetach={() => detachTable(selectedTable.id)}
              onDelete={() => deleteTable(selectedTable.id)}
            />
          ) : (
            <div className="settings-empty">
              <div className="selection-icon"><ChevronLeft /><span /></div>
              <h2>Выберите стол</h2>
              <p>Нажмите на стол, чтобы изменить название, форму, вместимость или поворот.</p>
              <div className="key-hints"><span><kbd>Пробел</kbd> двигать холст</span><span><kbd>Колесо</kbd> масштаб</span><span><kbd>Del</kbd> удалить стол</span></div>
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
        setSelectedTableId(table.id)
        setTableDialog(false)
      }} />}
      {templateDialog && <TemplateDialog onClose={() => setTemplateDialog(false)} onApply={applyTemplate} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function TableView({ table, guests, selected, seatMenu, onSelect, onDragStart, onDrop, onSeatMenu, onReturnGuest, onEditGuest, onDeleteGuest }: {
  table: SeatingTable
  guests: ProjectState['guests']
  selected: boolean
  seatMenu?: { tableId: string; seatId: string }
  onSelect: () => void
  onDragStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onDrop: (guestId: string, seatId: string) => void
  onSeatMenu: (seatId: string) => void
  onReturnGuest: (guestId: string) => void
  onEditGuest: (guestId: string) => void
  onDeleteGuest: (guestId: string) => void
}) {
  const size = tableSize(table)
  const seats = getSeats(table)
  return (
    <div
      className={`table-wrap ${selected ? 'selected' : ''}`}
      style={{ left: table.x, top: table.y, width: size.width, height: size.height, transform: `rotate(${table.rotation}deg)` }}
      onClick={(event) => { event.stopPropagation(); onSelect() }}
    >
      <div className={`table-body ${table.shape}`} onPointerDown={onDragStart}>
        <span className="table-name">{table.name}</span>
        <span className="table-meta">{seats.filter((seat) => !seat.side || !table.hiddenSides.includes(seat.side)).length} мест</span>
        {table.groupId && <span className="linked-mark">сцеплено</span>}
      </div>
      {seats.map((seat) => {
        if (seat.side && table.hiddenSides.includes(seat.side)) return null
        const guestId = table.assignments[seat.id]
        const guest = guests.find((item) => item.id === guestId)
        const menuOpen = seatMenu?.tableId === table.id && seatMenu.seatId === seat.id
        return (
          <div
            key={seat.id}
            className={`seat ${guest ? 'occupied' : ''}`}
            style={{ left: seat.x, top: seat.y, transform: `translate(-50%, -50%) rotate(${-table.rotation}deg)` }}
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
              if (guest) onSeatMenu(seat.id)
            }}
          >
            <b>{seat.number}</b>
            <span>{guest ? guest.name : 'свободно'}</span>
            {menuOpen && guest && (
              <div className="seat-menu" onClick={(event) => event.stopPropagation()}>
                <strong title={guest.name}>{guest.name}</strong>
                <button onClick={() => onReturnGuest(guest.id)}>Вернуть в список</button>
                <button onClick={() => onEditGuest(guest.id)}>Изменить имя</button>
                <button className="danger" onClick={() => onDeleteGuest(guest.id)}>Удалить гостя</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TableSettings({ table, onUpdate, onRotate, onDetach, onDelete }: {
  table: SeatingTable
  onUpdate: (id: string, patch: Partial<SeatingTable>, destructive?: boolean) => void
  onRotate: (direction: -1 | 1) => void
  onDetach: () => void
  onDelete: () => void
}) {
  const setSeats = (side: Side, value: number) => {
    const next = Math.max(0, Math.min(MAX_SEATS, value))
    const removedOccupied = getSeats(table).some((seat) => seat.side === side && Number(seat.id.split('-')[1]) >= next && table.assignments[seat.id])
    onUpdate(table.id, { sideSeats: { ...table.sideSeats, [side]: next } }, removedOccupied)
  }
  return (
    <>
      <div className="panel-heading settings-title"><div><span className="eyebrow">Настройки</span><h2>{table.name}</h2></div></div>
      <div className="settings-scroll">
        <label className="field"><span>Название стола</span><input value={table.name} maxLength={30} onChange={(event) => onUpdate(table.id, { name: event.target.value })} /></label>
        <div className="field"><span>Форма</span><div className="shape-picker">
          {([['rectangle', 'Прямой'], ['oval', 'Овальный'], ['circle', 'Круглый']] as [TableShape, string][]).map(([shape, label]) =>
            <button key={shape} disabled={!!table.groupId} className={table.shape === shape ? 'active' : ''} onClick={() => {
              if (shape !== table.shape && window.confirm('При смене формы рассаженные гости вернутся в список. Продолжить?')) onUpdate(table.id, { shape, assignments: {} })
            }}><i className={shape} />{label}</button>,
          )}
        </div></div>
        {table.shape === 'circle' ? (
          <label className="field"><span>Количество мест</span><NumberStepper value={table.circleSeats} onChange={(value) => onUpdate(table.id, { circleSeats: value }, value < table.circleSeats)} /></label>
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
        {table.groupId && <button className="button full quiet" onClick={onDetach}><Link2Off /> Отсоединить стол</button>}
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
      if (seat.side && table.hiddenSides.includes(seat.side)) return null
      const guest = guests.find((item) => item.id === table.assignments[seat.id])
      return <div key={seat.id} className={`export-seat ${guest ? 'filled' : ''}`} style={{ left: seat.x, top: seat.y, transform: `translate(-50%, -50%) rotate(${-table.rotation}deg)` }}><b>{seat.number}</b><span>{guest?.name || '—'}</span></div>
    })}
  </div>
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal"><div className="modal-title"><h2>{title}</h2><button onClick={onClose}><X /></button></div>{children}</div>
  </div>
}

function NumberStepper({ value, onChange, max = MAX_SEATS }: { value: number; onChange: (value: number) => void; max?: number }) {
  return <div className="stepper"><button onClick={() => onChange(Math.max(0, value - 1))}><Minus /></button><input type="number" min={0} max={max} value={value} onChange={(event) => onChange(Math.max(0, Math.min(max, Number(event.target.value))))} /><button onClick={() => onChange(Math.min(max, value + 1))}><Plus /></button></div>
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
