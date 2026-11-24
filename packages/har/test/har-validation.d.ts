// Neither package ships types. These declare the parts the schema tests use.
declare module "har-validator" {
  const validator: { har(data: unknown): Promise<unknown> };
  export default validator;
}

declare module "har-schema" {
  const schemas: Record<string, object>;
  export default schemas;
}
