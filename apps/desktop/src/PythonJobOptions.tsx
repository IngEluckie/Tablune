export default function PythonJobOptions({ value, onChange, disabled = false }: {
  value: number | null; onChange: (value: number | null) => void; disabled?: boolean;
}) {
  return <label>Time limit{" "}<select aria-label="Python job time limit" disabled={disabled} value={value ?? "none"}
    onChange={e => onChange(e.target.value === "none" ? null : Number(e.target.value))}>
    <option value={120}>2 minutes</option><option value={600}>10 minutes</option>
    <option value={3600}>1 hour</option><option value="none">No limit</option>
  </select></label>;
}
