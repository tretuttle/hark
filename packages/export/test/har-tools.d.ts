declare module "har-validator" {
  export function har<T>(data: T): Promise<T>;
}
