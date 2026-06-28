export class StateStoreOpenError extends Error {
  public readonly path: string

  public constructor(path: string, message: string) {
    super(`StateStoreOpenError: ${message}`)
    this.name = "StateStoreOpenError"
    this.path = path
  }
}

export class StateStoreConstraintError extends Error {
  public readonly constraint: string

  public constructor(constraint: string, message: string) {
    super(message)
    this.name = "StateStoreConstraintError"
    this.constraint = constraint
  }
}

export class StateStoreDataError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "StateStoreDataError"
  }
}

export class StateStoreReadOnlyError extends Error {
  public readonly operation: string

  public constructor(operation: string) {
    super(`State store was opened for read access and cannot run ${operation}`)
    this.name = "StateStoreReadOnlyError"
    this.operation = operation
  }
}
