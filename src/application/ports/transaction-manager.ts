export abstract class TransactionManager {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
  abstract withContext<T>(work: () => Promise<T>): Promise<T>;
}
