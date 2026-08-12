import { useNavigate } from "react-router-dom";
import { patch, type Todo } from "../api";

const TODO_STATUSES = ["idea", "in_progress", "done", "abandoned"] as const;

export default function TodoRow(props: { todo: Todo; onChanged: () => void }) {
  const { todo } = props;
  const navigate = useNavigate();

  async function setStatus(status: string) {
    await patch(`/todos/${todo.id}`, { status });
    props.onChanged();
  }

  return (
    <div className={`todo-row status-${todo.status}`}>
      <div className="todo-main" onClick={() => navigate(`/todos/${todo.id}`)}>
        <span className="title">{todo.title}</span>
        {todo.next_planned != null && (
          <span className="sched-chip" title="Has a planned slot">
            {new Date(todo.next_planned * 1000).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </span>
        )}
        <select
          value={todo.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setStatus(e.target.value)}
        >
          {TODO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
