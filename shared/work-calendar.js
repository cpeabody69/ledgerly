const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseDay(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  return new Date(year, (month || 1) - 1, date || 1);
}

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(day, count) {
  const date = parseDay(day);
  return iso(new Date(date.getFullYear(), date.getMonth(), date.getDate() + count));
}

export function startOfWeek(day) {
  const date = parseDay(day);
  const weekday = date.getDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(iso(date), mondayOffset);
}

export function shiftMonth(day, delta) {
  const date = parseDay(day);
  return iso(new Date(date.getFullYear(), date.getMonth() + delta, 1));
}

export function shiftWeek(day, delta) {
  return addDays(startOfWeek(day), delta * 7);
}

export function monthGrid(anchor) {
  const date = parseDay(anchor);
  const first = iso(new Date(date.getFullYear(), date.getMonth(), 1));
  const start = startOfWeek(first);
  const days = [];
  for (let index = 0; index < 42; index += 1) days.push(addDays(start, index));
  const last = iso(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  while (days.length > 28 && days[days.length - 7] > last) days.splice(-7, 7);
  return days;
}

export function weekGrid(anchor) {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function tasksOnDay(tasks, day) {
  return (tasks || []).filter((task) => task && task.dueOn === day);
}

export function taskTiming(task, today) {
  if (!task || task.status === "completed") return "done";
  if (task.dueOn && today && task.dueOn < today) return "overdue";
  return "upcoming";
}

export function monthTitle(anchor) {
  const date = parseDay(anchor);
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function weekTitle(anchor) {
  const days = weekGrid(anchor);
  const start = parseDay(days[0]);
  const end = parseDay(days[6]);
  const startLabel = `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()}`;
  const endLabel = start.getMonth() === end.getMonth()
    ? String(end.getDate())
    : `${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}`;
  return `${startLabel} – ${endLabel}, ${end.getFullYear()}`;
}
