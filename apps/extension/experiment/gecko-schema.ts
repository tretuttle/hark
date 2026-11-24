declare const valueType: unique symbol;

/** The Gecko WebExtension schema types this API uses. `any` defers every check to the parameter's parser. */
type GeckoType = { readonly type: "integer"; readonly minimum?: number } | { readonly type: "any" };

/**
 * One parameter: what Gecko's schema checks in the experiment host, and the parser every host runs before a handler
 * sees the value. The standard host's port has no schema in front of it, so the parser is the check that always runs.
 */
export type Parameter<T> = GeckoType & {
  readonly name: string;
  readonly parse: (raw: unknown) => T | null;
  readonly [valueType]?: T;
};

declare const resultType: unique symbol;

/** Carries a result type only. Gecko schemas cannot describe what an async function resolves to. */
export interface Result<T> {
  readonly [resultType]?: T;
}

export interface AsyncFunction<P extends ReadonlyArray<Parameter<unknown>>, R> {
  readonly parameters: P;
  readonly result: Result<R>;
}

export type ApiTable = Readonly<
  Record<string, AsyncFunction<ReadonlyArray<Parameter<unknown>>, unknown>>
>;

export type Arguments<P> = {
  -readonly [K in keyof P]: P[K] extends Parameter<infer T> ? T : never;
};

/** The functions a table describes, as the extension calls them and as a host implements them after parsing. */
export type ApiFunctions<Table extends ApiTable> = {
  readonly [Name in keyof Table]: Table[Name] extends AsyncFunction<infer P, infer R>
    ? (...args: Arguments<P>) => Promise<R>
    : never;
};

/** What each function resolves to, by name. */
export type ApiResults<Table extends ApiTable> = {
  readonly [Name in keyof Table]: Table[Name] extends AsyncFunction<infer _P, infer R> ? R : never;
};

/** What each function's parameters parse to, by name. */
export type ApiParameters<Table extends ApiTable> = {
  readonly [Name in keyof Table]: Table[Name] extends AsyncFunction<infer P, infer _R>
    ? Arguments<P>
    : never;
};

/* @__NO_SIDE_EFFECTS__ */
export const integer = <T extends number>(
  name: string,
  parse: (raw: unknown) => T | null,
  constraints: { readonly minimum?: number } = {},
): Parameter<T> => ({ name, type: "integer", ...constraints, parse });

/* @__NO_SIDE_EFFECTS__ */
export const any = <T>(name: string, parse: (raw: unknown) => T | null): Parameter<T> => ({
  name,
  type: "any",
  parse,
});

/* @__NO_SIDE_EFFECTS__ */
export const returns = <T>(): Result<T> => ({});

/* @__NO_SIDE_EFFECTS__ */
export const asyncFunction = <const P extends ReadonlyArray<Parameter<unknown>>, R>(
  parameters: P,
  result: Result<R>,
): AsyncFunction<P, R> => ({ parameters, result });

/**
 * Every argument through its parameter's parser, in order. null when one is refused or the count is wrong; the name of
 * the first refused parameter is returned so the host can say which.
 */
export const parseArguments = (
  fn: AsyncFunction<ReadonlyArray<Parameter<unknown>>, unknown>,
  raw: readonly unknown[],
):
  | { readonly ok: true; readonly values: unknown[] }
  | { readonly ok: false; readonly refused: string } => {
  if (raw.length > fn.parameters.length) return { ok: false, refused: "(extra argument)" };
  const values: unknown[] = [];
  for (const [index, parameter] of fn.parameters.entries()) {
    const value = parameter.parse(raw[index]);
    if (value === null) return { ok: false, refused: parameter.name };
    values.push(value);
  }
  return { ok: true, values };
};

/** The `schema.json` Gecko loads for an experiment namespace, in the shape `Schemas.sys.mjs` parses. */
export const toGeckoSchema = (namespace: string, table: ApiTable) => [
  {
    namespace,
    functions: Object.entries(table).map(([name, { parameters }]) => ({
      name,
      type: "function",
      async: true,
      parameters: parameters.map(({ parse: _parse, ...gecko }) => gecko),
    })),
  },
];
