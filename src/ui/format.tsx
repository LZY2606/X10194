export function short(value: string, length = 14) {
  return value.length > length ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}
