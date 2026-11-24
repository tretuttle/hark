// har-validator ships no types. This declares the part the export check uses.
declare module "har-validator" {
  export function har<T>(data: T): Promise<T>;
}
