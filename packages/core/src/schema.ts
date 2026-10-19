/**
 * Schemas. ai-kit accepts any Standard Schema (zod 4, valibot, arktype) and plain JSON Schema.
 * It needs two things from a schema: validation, and a JSON Schema to show the model.
 */

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

export interface JSONSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema | JSONSchema[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  allOf?: JSONSchema[]
  additionalProperties?: boolean | JSONSchema
  default?: unknown
  $ref?: string
  $defs?: Record<string, JSONSchema>
  definitions?: Record<string, JSONSchema>
  [key: string]: unknown
}

/** The parts of the Standard Schema v1 spec ai-kit uses. https://standardschema.dev */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
    /** Standard JSON Schema extension (zod >= 4.2 implements it). */
    readonly jsonSchema?: {
      readonly input: (options: { target: string }) => Record<string, unknown>
      readonly output?: (options: { target: string }) => Record<string, unknown>
    }
  }
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }

const jsonSchemaBrand = Symbol.for("ai-kit.jsonSchema")

/** A JSON Schema, optionally with a validator. Make one with `jsonSchema()`. */
export interface JsonSchemaWrapper<T = unknown> {
  readonly [jsonSchemaBrand]: true
  readonly jsonSchema: JSONSchema
  readonly validate?: (value: unknown) => ValidationResult<T>
  /** Phantom type, never set. */
  readonly _type?: T
}

export type Schema<T = unknown> = StandardSchemaV1<unknown, T> | JsonSchemaWrapper<T>

export type InferSchema<S> = S extends StandardSchemaV1<any, infer O>
  ? O
  : S extends JsonSchemaWrapper<infer T>
    ? T
    : unknown

export type ValidationResult<T> = { success: true; value: T } | { success: false; error: string }

/** Wrap a plain JSON Schema. Pass `validate` to check values, otherwise anything is accepted. */
export function jsonSchema<T = unknown>(
  schema: JSONSchema,
  validate?: (value: unknown) => ValidationResult<T>,
): JsonSchemaWrapper<T> {
  return { [jsonSchemaBrand]: true, jsonSchema: schema, validate }
}

export function isStandardSchema(s: unknown): s is StandardSchemaV1 {
  return typeof s === "object" && s !== null && "~standard" in s
}

export function isJsonSchemaWrapper(s: unknown): s is JsonSchemaWrapper {
  return typeof s === "object" && s !== null && jsonSchemaBrand in s
}

/** JSON Schema for a schema, cleaned of `$schema` so providers accept it. */
export function toJsonSchema(schema: Schema | JSONSchema | undefined): JSONSchema {
  if (!schema) return { type: "object", properties: {} }
  if (isJsonSchemaWrapper(schema)) return schema.jsonSchema
  if (isStandardSchema(schema)) {
    const std = schema["~standard"]
    if (std.jsonSchema) {
      const out = { ...(std.jsonSchema.input({ target: "draft-2020-12" }) as JSONSchema) }
      delete out.$schema
      return out
    }
    // zod 4 before the Standard JSON Schema extension
    const anySchema = schema as unknown as { toJSONSchema?: () => JSONSchema }
    if (typeof anySchema.toJSONSchema === "function") {
      const out = { ...anySchema.toJSONSchema() }
      delete out.$schema
      return out
    }
    throw new Error(
      `Can't get a JSON Schema from this ${std.vendor} schema. Wrap a JSON Schema with jsonSchema() instead.`,
    )
  }
  return schema as JSONSchema
}

export async function validate<T>(schema: Schema<T> | JSONSchema | undefined, value: unknown): Promise<ValidationResult<T>> {
  if (!schema) return { success: true, value: value as T }
  if (isJsonSchemaWrapper(schema)) {
    return schema.validate ? (schema.validate(value) as ValidationResult<T>) : { success: true, value: value as T }
  }
  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(value)
    if (result.issues) {
      const error = result.issues
        .map((i) => {
          const path = i.path?.map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".")
          return path ? `${path}: ${i.message}` : i.message
        })
        .join("; ")
      return { success: false, error }
    }
    return { success: true, value: result.value as T }
  }
  return { success: true, value: value as T }
}
