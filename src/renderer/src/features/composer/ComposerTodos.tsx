import { ChevronDown, CircleCheck, CircleDashed, ListTodo, LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import { hubTodoProgress, type HubTodo } from '../../domain/session-hub.ts'

/** 本轮待办固定在输入框上方，位置不依赖右侧栏或用量读数。 */
export function ComposerTodos({ todos }: { todos: readonly HubTodo[] }) {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  if (todos.length === 0) return null
  return (
    <section className="todo-card" aria-label="本轮待办">
      <div className="todo-card__body">
        <button
          type="button"
          className="todo-card__toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            setExpanded(value => !value)
          }}
        >
          <ListTodo size={14} aria-hidden="true" />
          <strong>本轮待办</strong>
          <span title={hubTodoProgress(todos)}>{hubTodoProgress(todos)}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {expanded && (
          <ul id={listId} className="todo-card__list" aria-label="任务清单" tabIndex={0}>
            {todos.map((todo, index) => (
              <li key={`${String(index)}-${todo.content}`} data-status={todo.status}>
                {todo.status === 'completed' ? (
                  <CircleCheck size={14} aria-hidden="true" />
                ) : todo.status === 'in_progress' ? (
                  <LoaderCircle size={14} className="spin" aria-hidden="true" />
                ) : (
                  <CircleDashed size={14} aria-hidden="true" />
                )}
                <span className="visually-hidden">
                  {todo.status === 'completed'
                    ? '已完成：'
                    : todo.status === 'in_progress'
                      ? '进行中：'
                      : '待处理：'}
                </span>
                <span className="todo-card__content" title={todo.content}>
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
