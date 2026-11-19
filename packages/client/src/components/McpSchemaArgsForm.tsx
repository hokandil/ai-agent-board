/**
 * Minimal schema-driven argument form shared by MCP tool testing and the
 * external-task import dialog.
 *
 * Supports string, number, integer, boolean, enum, array and nested object
 * properties. Unsupported/compound schemas fall back to a JSON textarea per
 * field, and callers can always offer a whole-payload JSON editor.
 */
export interface JsonSchemaShape {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export function asJsonSchema(inputSchema: unknown): JsonSchemaShape {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    return inputSchema as JsonSchemaShape;
  }
  return {};
}

function propertyType(prop: unknown): string | undefined {
  if (!prop || typeof prop !== 'object') return undefined;
  const record = prop as Record<string, unknown>;
  if (typeof record.type === 'string') return record.type;
  if (Array.isArray(record.type)) {
    const first = record.type.find((t) => typeof t === 'string' && t !== 'null');
    return typeof first === 'string' ? first : undefined;
  }
  if (Array.isArray(record.enum)) return 'enum';
  if (record.properties) return 'object';
  if (record.items) return 'array';
  return undefined;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Returns the first missing required field message, or null when valid. */
export function validateRequiredArgs(
  schema: JsonSchemaShape,
  values: Record<string, unknown>,
): string | null {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (isEmptyValue(values[key])) return `${key} is required`;
  }
  return null;
}

interface FieldInputProps {
  name: string;
  prop: unknown;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  idPrefix: string;
}

function FieldInput({ name, prop, required, value, onChange, idPrefix }: FieldInputProps) {
  const id = `${idPrefix}-${name}`;
  const type = propertyType(prop);
  const record = (prop && typeof prop === 'object' ? prop : {}) as Record<string, unknown>;
  const description = typeof record.description === 'string' ? record.description : undefined;
  const label = (
    <label className="block text-xs font-medium mb-1" htmlFor={id}>
      {name}
      {required ? ' *' : ''}
    </label>
  );
  const hint = description ? (
    <p className="text-[11px] text-muted-foreground mb-1">{description}</p>
  ) : null;

  if (type === 'enum' || (Array.isArray(record.enum) && record.enum.length > 0)) {
    const options = Array.isArray(record.enum) ? record.enum : [];
    return (
      <div>
        {label}
        {hint}
        <select
          id={id}
          data-testid={id}
          name={id}
          className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">{required ? 'Select a value…' : '(not set)'}</option>
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={id}
          name={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label className="text-xs font-medium" htmlFor={id}>
          {name}
          {required ? ' *' : ''}
        </label>
      </div>
    );
  }

  if (type === 'number' || type === 'integer') {
    return (
      <div>
        {label}
        {hint}
        <input
          id={id}
          data-testid={id}
          name={id}
          type="number"
          step={type === 'integer' ? '1' : 'any'}
          className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </div>
    );
  }

  if (type === 'array' || type === 'object') {
    const text = typeof value === 'string'
      ? value
      : value === undefined
        ? ''
        : JSON.stringify(value, null, 2);
    return (
      <div>
        <label className="block text-xs font-medium mb-1" htmlFor={id}>
          {name}
          {required ? ' *' : ''} <span className="text-muted-foreground">(JSON)</span>
        </label>
        {hint}
        <textarea
          id={id}
          data-testid={id}
          name={id}
          rows={3}
          className="w-full border border-border rounded px-2 py-1 text-xs font-mono bg-background"
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            if (next.trim() === '') {
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(next));
            } catch {
              // Keep the raw text so the user can finish typing; the caller
              // surfaces the JSON error when submitting.
              onChange(next);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {label}
      {hint}
      <input
        id={id}
        data-testid={id}
        name={id}
        type="text"
        className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
    </div>
  );
}

export interface McpSchemaArgsFormProps {
  schema: JsonSchemaShape;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  idPrefix?: string;
}

export function McpSchemaArgsForm({
  schema,
  values,
  onChange,
  idPrefix = 'mcp-arg',
}: McpSchemaArgsFormProps) {
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This tool takes no documented arguments.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {keys.map((key) => (
        <FieldInput
          key={key}
          name={key}
          prop={properties[key]}
          required={required.includes(key)}
          value={values[key]}
          onChange={(value) => {
            const next = { ...values };
            if (value === undefined) {
              delete next[key];
            } else {
              next[key] = value;
            }
            onChange(next);
          }}
          idPrefix={idPrefix}
        />
      ))}
    </div>
  );
}
